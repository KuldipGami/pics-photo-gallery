const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { pipeline } = require('node:stream/promises')
const exifr = require('exifr')
const { IMAGE_EXT, VIDEO_EXT, extOf, keyOf } = require('./library.cjs')
const organize = require('./organize.cjs')
const { uniquePath, moveFile } = require('./cleanup.cjs')
const { writeAtomicSync, readJsonSync } = require('./safe-file.cjs')

/**
 * Import from a phone, a memory card or any folder: copies only the photos and videos that aren't
 * in the library yet into dated folders (organize.cjs patterns), keeping file dates, never
 * overwriting anything, optionally converting HEIC to JPG and removing the originals from a card.
 *
 * Sources:
 *  - drive:  a memory card / camera / USB drive (a drive letter; its DCIM folder when it has one)
 *  - device: a phone or camera connected over MTP (no drive letter). Windows only shows these to
 *            programs through the Shell, so a hidden PowerShell process (AGENT_PS) walks and copies
 *            them with Shell.Application (Folder.CopyHere into a staging folder, then waits).
 *  - folder: any folder the user picks.
 *
 * Already imported = same content as a library file (same size + contentHash, the hash Clean up
 * uses), checked before copying for drives and folders and after copying for phones (a phone file
 * can only be read by copying it, so name/date + size is the quick check there). imports.json
 * remembers what came from each source, so files imported once and deleted since can be skipped.
 */

// ── constants ──────────────────────────────────────────────────────────────

const EXIF_EXT = new Set(['jpg', 'jpeg', 'jfif', 'heic', 'heif', 'tif', 'tiff', 'dng', 'cr2', 'nef', 'arw', 'orf', 'rw2', 'avif', 'webp', 'png'])
const MP4_EXT = new Set(['mp4', 'm4v', 'mov', '3gp'])
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '__macosx', 'node_modules', 'appdata'])
/** Folders on a phone that hold the user's own photos and videos (in each storage). */
const DEVICE_FOLDERS = ['DCIM', 'Pictures', 'Movies']
/** Camera folders on a card besides DCIM (Sony / AVCHD video). */
const CARD_FOLDERS = ['DCIM', 'PRIVATE\\M4ROOT\\CLIP', 'PRIVATE\\AVCHD\\BDMV\\STREAM', 'AVCHD\\BDMV\\STREAM', 'MP_ROOT']
/** Staging folder (inside the destination, so moving out of it is a rename). Dot folders are never scanned. */
const STAGING = '.lumen-import'
const TEMP_SUFFIX = '.lumen-import'
const STREAM_COPY_MIN = 64 * 1024 * 1024 // bigger files are copied in chunks, so Cancel stops them halfway
const HEIC_ORIGINALS = ['aside', 'next', 'none']

const DEFAULTS = {
  folderPattern: organize.DEFAULTS.folderPattern,
  skipImported: true,
  convertHeic: false,
  heicOriginals: 'aside',
  deleteAfter: false,
}

// ── small helpers ──────────────────────────────────────────────────────────

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')
const exists = (p) => {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
const trimSep = (p) => String(p).replace(/[\\/]+$/, '')
const isUnder = (file, folder) => {
  const f = trimSep(file).toLowerCase()
  const d = trimSep(folder).toLowerCase()
  return f === d || f.startsWith(d + path.sep)
}
const isMediaExt = (ext) => IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)
const isHeicExt = (ext) => ext === 'heic' || ext === 'heif'
const near = (a, b, ms = 2000) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= ms
const stemOf = (name) => path.basename(name, path.extname(name)).toLowerCase()
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' })

/** The remembered key of a source file: name + size survives the phone reshuffling its folders. */
const memoryKey = (name, size) => `${String(name).toLowerCase()}|${Number(size) || 0}`

/** Runs `fn` over `list` with at most `limit` at a time. */
async function pool(list, limit, fn) {
  let i = 0
  const worker = async () => {
    while (i < list.length) await fn(list[i++])
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker))
}

// ── content hash (same as duplicates.cjs, so hashes match Clean up's records `x`) ──

const FULL_HASH_MAX = 32 * 1024 * 1024
const SAMPLE = 64 * 1024
const SAMPLES = 32

/** Same size and content hash: whole-file SHA-1 for photos; size + head, tail and 32 samples for big files. */
async function contentHash(file, size) {
  const h = crypto.createHash('sha1')
  h.update(String(size))
  if (size <= FULL_HASH_MAX) {
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) h.update(chunk)
  } else {
    const fh = await fsp.open(file, 'r')
    try {
      const buf = Buffer.alloc(1024 * 1024)
      await fh.read(buf, 0, buf.length, 0)
      h.update(buf)
      await fh.read(buf, 0, buf.length, size - buf.length)
      h.update(buf)
      const chunk = Buffer.alloc(SAMPLE)
      for (let i = 1; i <= SAMPLES; i++) {
        await fh.read(chunk, 0, SAMPLE, Math.floor((size - SAMPLE) * (i / (SAMPLES + 1))))
        h.update(chunk)
      }
    } finally {
      await fh.close()
    }
  }
  return h.digest('base64').slice(0, 24)
}

/** Reads up to `length` bytes at `position` (fewer only at the end of the file). */
async function readFull(fh, buf, length, position) {
  let got = 0
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got)
    if (!bytesRead) break
    got += bytesRead
  }
  return got
}

/**
 * True when two files hold exactly the same bytes, every one of them compared (whatever the size;
 * contentHash only samples big files). Used before an original is deleted from a card.
 */
async function sameContent(a, b, signal) {
  const fa = await fsp.open(a, 'r')
  let fb
  try {
    fb = await fsp.open(b, 'r')
    const [sa, sb] = await Promise.all([fa.stat(), fb.stat()])
    if (sa.size !== sb.size) return false
    const CHUNK = 4 * 1024 * 1024
    const x = Buffer.allocUnsafe(CHUNK)
    const y = Buffer.allocUnsafe(CHUNK)
    for (let pos = 0; pos < sa.size; ) {
      if (signal?.aborted) throw abortError()
      const want = Math.min(CHUNK, sa.size - pos)
      const [n, m] = await Promise.all([readFull(fa, x, want, pos), readFull(fb, y, want, pos)])
      if (n !== want || m !== want || !x.subarray(0, n).equals(y.subarray(0, m))) return false
      pos += n
    }
    return true
  } finally {
    await fa.close().catch(() => {})
    await fb?.close().catch(() => {})
  }
}

// ── capture dates (like library.cjs, which doesn't export its readers) ─────

const MAC_EPOCH = Date.UTC(1904, 0, 1)
const validDate = (ms) => Number.isFinite(ms) && ms > Date.UTC(1971, 0, 1) && ms < Date.now() + 86_400_000

/** { taken, meta } from a photo's EXIF (meta: camera, exposure, place; used when converting). */
async function readPhoto(file) {
  try {
    const d = await exifr.parse(file, {
      tiff: true, exif: true, gps: true, ifd1: false, interop: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false, translateValues: false,
    })
    if (!d) return { taken: null, meta: undefined }
    const t = d.DateTimeOriginal || d.CreateDate || d.ModifyDate
    const meta = {}
    if (d.Make) meta.make = String(d.Make).trim()
    if (d.Model) meta.model = String(d.Model).trim()
    if (d.LensModel) meta.lens = String(d.LensModel).trim()
    if (d.FNumber) meta.f = d.FNumber
    if (d.ExposureTime) meta.exposure = d.ExposureTime
    if (d.ISO) meta.iso = d.ISO
    if (d.FocalLength) meta.focal = d.FocalLength
    if (Number.isFinite(d.latitude) && Number.isFinite(d.longitude)) {
      meta.lat = d.latitude
      meta.lon = d.longitude
    }
    const taken = t instanceof Date ? t.getTime() : NaN
    return { taken: validDate(taken) ? taken : null, meta: Object.keys(meta).length ? meta : undefined }
  } catch {
    return { taken: null, meta: undefined }
  }
}

/** Creation time from an MP4/MOV `mvhd` box (UTC seconds since 1904), or null. */
async function readVideoDate(file) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const { size } = await fh.stat()
    const hdr = Buffer.alloc(16)
    let pos = 0
    while (pos + 8 <= size) {
      await fh.read(hdr, 0, 16, pos)
      let boxSize = hdr.readUInt32BE(0)
      const type = hdr.toString('latin1', 4, 8)
      let headerLen = 8
      if (boxSize === 1) {
        boxSize = Number(hdr.readBigUInt64BE(8))
        headerLen = 16
      } else if (boxSize === 0) boxSize = size - pos
      if (boxSize < headerLen) return null
      if (type === 'moov') {
        const moov = Buffer.alloc(Math.min(boxSize - headerLen, 16 * 1024 * 1024))
        await fh.read(moov, 0, moov.length, pos + headerLen)
        for (let c = 0; c + 8 <= moov.length; ) {
          const childSize = moov.readUInt32BE(c)
          if (moov.toString('latin1', c + 4, c + 8) === 'mvhd' && c + 40 <= moov.length) {
            const b = moov.subarray(c + 8, c + 40)
            const created = b[0] === 1 ? Number(b.readBigUInt64BE(4)) : b.readUInt32BE(4)
            const ms = created ? MAC_EPOCH + created * 1000 : NaN
            return validDate(ms) ? ms : null
          }
          if (childSize < 8) break
          c += childSize
        }
        return null
      }
      pos += boxSize
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Capture date (ms) of a media file, or null. */
async function readTaken(file, ext) {
  if (MP4_EXT.has(ext)) return readVideoDate(file)
  if (EXIF_EXT.has(ext)) return (await readPhoto(file)).taken
  return null
}

/** The dated folder (absolute) for a date; `\` in the formatted pattern makes nested folders. */
function datedFolder(root, date, pattern, locale) {
  return path.join(root, ...organize.formatDate(date, pattern, locale).split('\\').filter(Boolean))
}

// ── imports.json: what came from each source ───────────────────────────────

/**
 * { version: 1, sources: { [sourceId]: { name, kind, last, keys: { [name|size]: time } } } }
 * Keys are added for files imported and files found already in the library, so the next import
 * from the same phone or card is quick and skips files that were imported and deleted since.
 */
class ImportMemory {
  constructor(file) {
    this.file = file
    this.data = { version: 1, sources: {} }
    this.timer = null
    this.readOnly = false // imports.json is there but couldn't be read: never written over this session
    if (!file) return
    const res = readJsonSync(file) // a damaged file is kept aside, not treated as empty and overwritten
    if (res.error) this.readOnly = true
    const saved = res.data
    if (saved?.version === 1 && saved.sources && typeof saved.sources === 'object') this.data = saved
    else if (saved !== undefined) this.readOnly = true // a format this version doesn't know
  }

  has(sourceId, key) {
    return !!this.data.sources[sourceId]?.keys?.[key]
  }

  info(sourceId) {
    const s = this.data.sources[sourceId]
    return { remembered: s ? Object.keys(s.keys ?? {}).length : 0, lastImport: s?.last ?? null }
  }

  add(source, keys) {
    if (!keys.length) return
    const now = Date.now()
    const s = (this.data.sources[source.id] ??= { name: source.name, kind: source.kind, last: now, keys: {} })
    s.name = source.name
    s.last = now
    for (const k of keys) s.keys[k] = now
    this.saveSoon()
  }

  /** Forgets some keys of a source (undoing an import), or the whole source. Returns how many. */
  forget(sourceId, keys) {
    const s = this.data.sources[sourceId]
    if (!s) return 0
    let n = 0
    if (!keys) {
      n = Object.keys(s.keys ?? {}).length
      delete this.data.sources[sourceId]
    } else {
      for (const k of keys) if (s.keys[k] && delete s.keys[k]) n++
    }
    this.saveSoon()
    return n
  }

  saveSoon() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), 500)
  }

  saveNow() {
    clearTimeout(this.timer)
    this.timer = null
    if (!this.file || this.readOnly) return
    try {
      writeAtomicSync(this.file, JSON.stringify(this.data))
    } catch (err) {
      console.error('Failed to save imports.json', err)
    }
  }
}

// ── the Shell agent (phones and cameras over MTP) ──────────────────────────

/**
 * PowerShell, run hidden with -Sta. Reads one JSON request per line on stdin and answers with JSON
 * lines carrying the request's id: { t: 'files' | 'dir' } while working, then { t: 'done' } or
 * { t: 'error', message }. Exits when stdin closes (so it never outlives Pics).
 *   list                     → done { devices: [{ name, path, type }], disks: [{ letter, type, label, serial, size, free, fs }] }
 *   scan { root, folders }   → files { files: [{ rel, name, size, mtime, taken }] }…, done { roots }
 *   copy { root, rel, dest, size } → done { path, size }  (dest must be a new empty folder)
 * `root` is a portable device's Shell path from `list` (or, for tests, a plain folder). Dates
 * are UTC milliseconds (the Shell's property dates are UTC with an unspecified kind).
 */
const AGENT_PS = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object Text.UTF8Encoding($false)
$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$sh = New-Object -ComObject Shell.Application
$roots = @{}
$dirs = @{}

function Send($o) { $stdout.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 5)) }
function P($it, $k) { try { return $it.ExtendedProperty($k) } catch { return $null } }
function Ms($d) {
  if ($d -isnot [DateTime]) { return $null }
  $u = [DateTime]::SpecifyKind($d, [DateTimeKind]::Utc)
  if ($u.Year -lt 1971) { return $null }
  return ([DateTimeOffset]$u).ToUnixTimeMilliseconds()
}
function NameOf($it) {
  $n = [string](P $it 'System.FileName')
  if (-not $n) {
    $n = [string]$it.Name
    $e = [string](P $it 'System.FileExtension')
    if ($e -and -not $n.EndsWith($e, [StringComparison]::OrdinalIgnoreCase)) { $n += $e }
  }
  return $n
}
function IsDir($it) {
  if (-not $it.IsFolder) { return $false }
  if ($it.IsFileSystem) { return [IO.Directory]::Exists([string]$it.Path) }
  return $true
}
function RootFolder($root) {
  if ($roots.ContainsKey($root)) { return $roots[$root] }
  $f = $null
  foreach ($i in $sh.Namespace(17).Items()) { if ([string]$i.Path -eq $root) { $f = $i.GetFolder; break } }
  if (-not $f -and [IO.Directory]::Exists($root)) { $f = $sh.Namespace($root) }
  if (-not $f) { throw 'The device is no longer connected.' }
  $roots[$root] = $f
  return $f
}
function GetDir($root, $rel) {
  $k = $root + '|' + $rel
  if ($dirs.ContainsKey($k)) { return $dirs[$k] }
  if ($rel -eq '') { $f = RootFolder $root }
  else {
    $i = $rel.LastIndexOf('\')
    $parent = ''
    if ($i -ge 0) { $parent = $rel.Substring(0, $i) }
    $p = GetDir $root $parent
    $c = $p.items[$rel.Substring($i + 1)]
    if (-not $c) { throw ('Folder not found: ' + $rel) }
    $f = $c.it.GetFolder
  }
  $map = @{}
  foreach ($c in $f.Items()) { $n = NameOf $c; $map[$n] = [pscustomobject]@{ it = $c; name = $n } }
  $d = [pscustomobject]@{ folder = $f; items = $map }
  $dirs[$k] = $d
  return $d
}
function Walk($root, $rel, $depth, $id, $batch) {
  $d = GetDir $root $rel
  Send @{ id = $id; t = 'dir'; rel = $rel }
  foreach ($c in @($d.items.Values)) {
    if ($c.name.StartsWith('.')) { continue }
    $r = $rel + '\' + $c.name
    if (IsDir $c.it) { if ($depth -lt 10) { Walk $root $r ($depth + 1) $id $batch }; continue }
    $it = $c.it
    [void]$batch.Add(@{ rel = $r; name = $c.name; size = (P $it 'System.Size'); mtime = (Ms (P $it 'System.DateModified')); taken = (Ms (P $it 'System.Photo.DateTaken')) })
    if ($batch.Count -ge 100) { Send @{ id = $id; t = 'files'; files = @($batch.ToArray()) }; $batch.Clear() }
  }
}
function Scan($root, $folders, $id) {
  $want = @{}
  foreach ($w in $folders) { $want[[string]$w] = $true }
  $starts = New-Object Collections.ArrayList
  $top = GetDir $root ''
  foreach ($c in @($top.items.Values)) {
    if (-not (IsDir $c.it)) { continue }
    if ($want.ContainsKey($c.name)) { [void]$starts.Add($c.name); continue }
    $sub = GetDir $root $c.name
    foreach ($s in @($sub.items.Values)) { if ($want.ContainsKey($s.name) -and (IsDir $s.it)) { [void]$starts.Add($c.name + '\' + $s.name) } }
  }
  $batch = New-Object Collections.ArrayList
  foreach ($s in $starts) { Walk $root $s 0 $id $batch }
  if ($batch.Count) { Send @{ id = $id; t = 'files'; files = @($batch.ToArray()) } }
  Send @{ id = $id; t = 'done'; roots = @($starts.ToArray()) }
}
function CopyOne($root, $rel, $dest, $size, $id) {
  $i = $rel.LastIndexOf('\')
  $parent = ''
  if ($i -ge 0) { $parent = $rel.Substring(0, $i) }
  $c = (GetDir $root $parent).items[$rel.Substring($i + 1)]
  if (-not $c) { throw 'This file is no longer on the device.' }
  [void][IO.Directory]::CreateDirectory($dest)
  if ([IO.Directory]::GetFileSystemEntries($dest).Length) { throw 'The staging folder is not empty.' }
  $sh.Namespace($dest).CopyHere($c.it, 1556)
  # CopyHere returns at once: done = one file, its size unchanged for 120 ms and nobody holding it
  $last = -1; $stable = 0; $poll = 30
  $idle = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    Start-Sleep -Milliseconds $poll
    if ($poll -lt 250) { $poll += 20 }
    $files = [IO.Directory]::GetFiles($dest)
    if ($files.Length -eq 1) {
      $len = (New-Object IO.FileInfo($files[0])).Length
      if ($len -ne $last) { $last = $len; $stable = 0; $idle.Restart() }
      else {
        $free = $false
        try { $fs = [IO.File]::Open($files[0], 'Open', 'Read', 'None'); $fs.Close(); $free = $true } catch {}
        if ($free) { $stable++ } else { $stable = 0 }
        if ($stable -ge 2 -and $idle.ElapsedMilliseconds -ge 120 -and ($len -ge $size -or $stable -ge 10)) { Send @{ id = $id; t = 'done'; path = $files[0]; size = $len }; return }
      }
    }
    $limit = 60000
    if ($last -ge 0) { $limit = 120000 }
    if ($idle.ElapsedMilliseconds -gt $limit) { throw 'The device stopped responding while copying.' }
  }
}
function List($id) {
  $devices = New-Object Collections.ArrayList
  foreach ($i in $sh.Namespace(17).Items()) {
    if ($i.IsFileSystem) { continue }
    $p = [string]$i.Path
    if ($p -notmatch '\\\\\?\\') { continue }
    [void]$devices.Add(@{ name = [string]$i.Name; path = $p; type = [string]$i.Type })
  }
  $disks = New-Object Collections.ArrayList
  try {
    foreach ($d in Get-CimInstance Win32_LogicalDisk) {
      [void]$disks.Add(@{ letter = [string]$d.DeviceID; type = [int]$d.DriveType; label = [string]$d.VolumeName; serial = [string]$d.VolumeSerialNumber; size = [double]$d.Size; free = [double]$d.FreeSpace; fs = [string]$d.FileSystem })
    }
  } catch {}
  Send @{ id = $id; t = 'done'; devices = @($devices.ToArray()); disks = @($disks.ToArray()) }
}
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $m = ConvertFrom-Json $line
    $id = $m.id
    switch ([string]$m.op) {
      'list' { List $id }
      'scan' { $dirs.Clear(); Scan ([string]$m.root) @($m.folders) $id }
      'copy' { CopyOne ([string]$m.root) ([string]$m.rel) ([string]$m.dest) ([double]$m.size) $id }
      'ping' { Send @{ id = $id; t = 'done' } }
      default { throw ('Unknown request ' + $m.op) }
    }
  } catch {
    $msg = [string]$_.Exception.Message
    if (-not $msg.StartsWith('This file')) { $roots.Clear(); $dirs.Clear() }
    Send @{ id = $id; t = 'error'; message = $msg }
  }
}
`

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

// The agent runs from a plain script file. An -EncodedCommand is what malware uses, so antivirus
// "behaviour shields" kill it and show the user a threat warning. (A file inside app.asar can't be
// run, so the script is written next to Pics' data.)
let scriptDir = require('node:os').tmpdir()
function agentScript() {
  const file = path.join(scriptDir, 'import-agent.ps1')
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== AGENT_PS) fs.writeFileSync(file, AGENT_PS)
  } catch {}
  return file
}

function spawnPowerShell() {
  return spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', agentScript()], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * One PowerShell agent process: requests go out as JSON lines and are answered in order. Starts on
 * first use; stops after `idleMs` without requests. `spawnFn` returns a ChildProcess-like object
 * (tests pass a fake that replays captured output).
 */
class ShellAgent {
  constructor({ spawnFn = spawnPowerShell, idleMs = 5 * 60_000 } = {}) {
    this.spawnFn = spawnFn
    this.idleMs = idleMs
    this.proc = null
    this.seq = 0
    this.pending = new Map()
    this.idleTimer = null
  }

  ensure() {
    if (this.proc) return this.proc
    const proc = this.spawnFn()
    this.proc = proc
    let buf = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) this.onLine(line)
      }
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)))
    const finish = (code) => {
      if (this.proc !== proc) return
      this.proc = null
      // (PowerShell writes progress as CLIXML on a redirected stderr: that's not an error)
      const said = stderr.split(/\r?\n/).find((l) => l.trim() && !/^#< CLIXML|^<Objs /.test(l))
      const how = code instanceof Error ? ` (${code.message})` : Number.isInteger(code) ? ` (exit code ${code})` : ''
      const err = Object.assign(new Error(said?.trim() || `The connection to the device closed${how}.`), { code: 'AGENT_EXIT' })
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
    proc.on('exit', finish)
    proc.on('error', finish)
    proc.stdin.on('error', () => {})
    return proc
  }

  onLine(line) {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    const p = this.pending.get(m.id)
    if (!p) return
    if (m.t === 'done') {
      this.pending.delete(m.id)
      p.resolve(m)
    } else if (m.t === 'error') {
      this.pending.delete(m.id)
      p.reject(new Error(m.message || 'The device reported an error.'))
    } else p.onEvent?.(m)
    this.touch()
  }

  /** Sends a request; resolves with its `done` message. `signal` stops the agent (and the request). */
  request(op, args = {}, { onEvent, signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError())
    const proc = this.ensure()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        reject(abortError())
        this.kill()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = (fn) => (v) => {
        signal?.removeEventListener('abort', onAbort)
        fn(v)
      }
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), onEvent })
      this.touch()
      proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n')
    })
  }

  touch() {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.pending.size) this.kill()
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  kill() {
    clearTimeout(this.idleTimer)
    const proc = this.proc
    if (!proc) return
    this.proc = null
    for (const p of this.pending.values()) p.reject(abortError())
    this.pending.clear()
    try {
      proc.stdin.end()
    } catch {}
    try {
      proc.kill()
    } catch {}
  }
}

// ── sources ────────────────────────────────────────────────────────────────

const DRIVE_TYPES = { 2: 'removable', 3: 'fixed' }

/** A drive (from the agent's `list`) as an import source. */
function driveSource(d, dcim) {
  const letter = String(d.letter).toUpperCase()
  const label = String(d.label || '').trim()
  const removable = d.type === 2
  return {
    id: `drive:${(d.serial || `${letter}${label}`).toLowerCase()}`,
    kind: 'drive',
    name: label ? `${label} (${letter})` : removable ? `Memory card (${letter})` : `Drive (${letter})`,
    detail: dcim ? (removable ? 'Memory card or camera' : 'Camera drive') : 'USB drive',
    path: `${letter}\\`,
    removable,
    hasDcim: dcim,
    canDelete: true,
    size: Number(d.size) || 0,
    free: Number(d.free) || 0,
  }
}

/** A phone or camera seen through the Shell (MTP/PTP) as an import source. */
function deviceSource(dev) {
  const name = String(dev.name || 'Phone')
  return {
    id: `device:${sha1(String(dev.path).toLowerCase()).slice(0, 16)}`,
    kind: 'device',
    name,
    detail: /iphone|ipad|apple/i.test(name) ? 'iPhone or iPad' : dev.type ? String(dev.type) : 'Phone or camera',
    path: String(dev.path),
    removable: true,
    hasDcim: true,
    // Phones can't be asked to delete safely through the Shell (it shows its own confirmation
    // and can't confirm what it removed), so Pics never deletes from them.
    canDelete: false,
  }
}

/** Any folder as an import source. */
function folderSource(dir) {
  const clean = trimSep(path.resolve(dir))
  const root = /^[a-z]:$/i.test(clean) ? `${clean}\\` : clean
  return {
    id: `folder:${sha1(keyOf(root)).slice(0, 16)}`,
    kind: 'folder',
    name: path.basename(root) || root,
    detail: root,
    path: root,
    removable: false,
    hasDcim: isDir(path.join(root, 'DCIM')),
    canDelete: true,
  }
}

/**
 * Import sources from the agent's `list` answer: removable drives (cards, USB sticks) with media in
 * them, fixed drives only when they have a DCIM folder (USB camera drives), never the system drive
 * or a drive whose DCIM is inside a library folder; then every portable device.
 * `probe(dir)` → is it a folder (tests pass their own, so no real drive is looked at).
 */
function sourcesFromList(res, { probe = isDir, exclude = [], systemDrive = process.env.SystemDrive || 'C:' } = {}) {
  const out = []
  for (const d of res?.disks ?? []) {
    if (!DRIVE_TYPES[d.type] || !(Number(d.size) > 0)) continue // network/optical drives, empty card readers
    const letter = String(d.letter).toUpperCase()
    if (!/^[A-Z]:$/.test(letter) || letter === String(systemDrive).toUpperCase()) continue
    const dcimDir = `${letter}\\DCIM`
    const dcim = probe(dcimDir)
    if (d.type === 3 && !dcim) continue
    if (dcim && exclude.some((f) => isUnder(dcimDir, f) || isUnder(f, dcimDir))) continue
    out.push(driveSource(d, dcim))
  }
  for (const dev of res?.devices ?? []) if (dev?.path) out.push(deviceSource(dev))
  return out
}

// ── the importer ───────────────────────────────────────────────────────────

/**
 * new Importer({ file: <userData>/imports.json })
 *   listSources({ exclude })      → sources (drives, phones) with { remembered, lastImport }
 *   folderSource(dir)             → a folder source
 *   scan(source, opts)            → ImportScan (what the view shows), kept as the current session
 *   plan(scanId, options)         → { count, bytes, heic, folders, preview } for the chosen options
 *   run(scanId, options)          → ImportResult incl. `entry` (History entry, kind 'imported')
 *   undo(entry, trash)            → moves an import's copies to the Recycle Bin, forgets them
 *   thumbItem(id)                 → a thumbs.cjs item for a drive/folder candidate's preview
 *   forget(sourceId), dispose()
 */
class Importer {
  constructor({ file = null, spawnFn, agentIdleMs } = {}) {
    if (file) scriptDir = path.dirname(file)
    this.memory = new ImportMemory(file)
    this.agentOptions = { spawnFn, idleMs: agentIdleMs }
    this.lister = null
    this.device = null
    this.session = null
    this.busy = null
    this.hashCache = new Map()
  }

  listerAgent() {
    return (this.lister ??= new ShellAgent({ ...this.agentOptions, idleMs: 30_000 }))
  }

  deviceAgent() {
    return (this.device ??= new ShellAgent(this.agentOptions))
  }

  withMemory(source) {
    return { ...source, ...this.memory.info(source.id) }
  }

  /** Connected phones, cameras and cards. opts: { exclude: library folders, probe? }. */
  async listSources(opts = {}) {
    if (process.platform !== 'win32' && !this.agentOptions.spawnFn) return []
    const res = await retryOnce(() => this.listerAgent().request('list'))
    return sourcesFromList(res, opts).map((s) => this.withMemory(s))
  }

  folderSource(dir) {
    return this.withMemory(folderSource(dir))
  }

  forget(sourceId) {
    const n = this.memory.forget(sourceId)
    if (this.session?.source.id === sourceId) {
      for (const c of this.session.candidates) if (c.status === 'imported') c.status = 'new'
      Object.assign(this.session.source, this.memory.info(sourceId))
    }
    return n
  }

  /**
   * Looks through a source and works out what is new.
   * opts: { items: library items, hashOf?(item) → cached contentHash, skipExtensions?: Set,
   *         minBytes?, signal?, onProgress?({ phase: 'listing' | 'checking', done, total }) }
   * Resolves to an ImportScan (see src/components/ImportView.tsx).
   */
  async scan(source, opts = {}) {
    if (this.busy) throw new Error(`Pics is still ${this.busy}.`)
    this.busy = 'looking through a device'
    try {
      const session = {
        scanId: crypto.randomBytes(6).toString('hex'),
        source: this.withMemory(source),
        candidates: [],
        byId: new Map(),
        skipped: new Map(), // ext → count
        roots: [],
        errors: [],
      }
      if (source.kind === 'device') await this.listDevice(session, opts)
      else await this.listFiles(session, opts)
      await this.classify(session, opts)
      this.session = session
      return this.summary(session)
    } finally {
      this.busy = null
    }
  }

  /** Media and skipped files of a drive or folder (with dates read from the files). */
  async listFiles(session, { signal, onProgress, skipExtensions, minBytes = 0 }) {
    const { source } = session
    let roots = [source.path]
    if (source.kind === 'drive') {
      const found = CARD_FOLDERS.map((f) => path.join(source.path, f)).filter(isDir)
      if (found.length) roots = found
    }
    session.roots = roots
    const files = []
    let lastTick = 0
    const tick = () => {
      const now = Date.now()
      if (now - lastTick < 150) return
      lastTick = now
      onProgress?.({ phase: 'listing', done: files.length, total: 0 })
    }
    for (const root of roots) await walkFiles(root, files, tick, signal)
    if (signal?.aborted) throw abortError()
    onProgress?.({ phase: 'listing', done: files.length, total: 0 })
    await pool(files, 8, async (file) => {
      if (signal?.aborted) return
      const name = path.basename(file)
      const ext = extOf(name)
      let st
      try {
        st = await fsp.stat(file)
      } catch {
        return
      }
      if (!isMediaExt(ext) || skipExtensions?.has(ext) || st.size < minBytes || st.size === 0) {
        const k = ext ? `.${ext}` : '(no extension)'
        session.skipped.set(k, (session.skipped.get(k) ?? 0) + 1)
        return
      }
      this.addCandidate(session, { rel: path.relative(source.path, file), name, path: file, size: st.size, mtime: Math.round(st.mtimeMs), taken: null })
    })
    if (signal?.aborted) throw abortError()
  }

  /** Media and skipped files of a phone, through the agent. */
  async listDevice(session, { signal, onProgress, skipExtensions, minBytes = 0 }) {
    const { source } = session
    let found = 0
    const fresh = () => {
      found = 0
      session.candidates = []
      session.byId.clear()
      session.skipped.clear()
    }
    const res = await retryOnce(() => (fresh(), this.deviceAgent().request(
      'scan',
      { root: source.path, folders: DEVICE_FOLDERS },
      {
        signal,
        onEvent: (m) => {
          if (m.t !== 'files') return
          for (const f of m.files ?? []) {
            const name = String(f.name || path.basename(String(f.rel)))
            const ext = extOf(name)
            const size = Number(f.size) || 0
            found++
            if (!isMediaExt(ext) || skipExtensions?.has(ext) || (size > 0 && size < minBytes)) {
              const k = ext ? `.${ext}` : '(no extension)'
              session.skipped.set(k, (session.skipped.get(k) ?? 0) + 1)
              continue
            }
            const mtime = Number.isFinite(f.mtime) ? f.mtime : Number.isFinite(f.taken) ? f.taken : Date.now()
            this.addCandidate(session, {
              rel: String(f.rel).replace(/^\\+/, ''),
              name,
              path: null,
              size,
              mtime,
              taken: validDate(f.taken) ? f.taken : null,
            })
          }
          onProgress?.({ phase: 'listing', done: found, total: 0 })
        },
      },
    )), signal)
    session.roots = res.roots ?? []
    if (!session.roots.length) session.errors.push(`No DCIM folder was found on ${source.name}. Unlock the phone and allow access to photos, then look again.`)
  }

  addCandidate(session, f) {
    const ext = extOf(f.name)
    const c = {
      id: sha1(`${session.source.id}|${f.rel.toLowerCase()}`).slice(0, 16),
      rel: f.rel,
      name: f.name,
      path: f.path,
      dir: f.path ? path.dirname(f.path) : `${session.source.name}\\${path.dirname(f.rel)}`,
      ext,
      type: VIDEO_EXT.has(ext) ? 'video' : 'image',
      size: f.size,
      mtime: f.mtime,
      taken: f.taken,
      key: memoryKey(f.name, f.size),
      status: 'new',
      match: null,
      likely: false,
      check: false,
      hash: null,
    }
    session.candidates.push(c)
    session.byId.set(c.id, c)
  }

  /** A library file's content hash (Clean up's cached one when it has it). */
  async libraryHash(item, hashOf) {
    const cached = hashOf?.(item)
    if (cached) return cached
    const k = `${keyOf(item.path)}|${item.size}|${item.mtime}`
    if (this.hashCache.has(k)) return this.hashCache.get(k)
    let h = null
    try {
      h = await contentHash(item.path, item.size)
    } catch {}
    if (this.hashCache.size > 50_000) this.hashCache.clear()
    this.hashCache.set(k, h)
    return h
  }

  /**
   * Status of every candidate: 'library' (same content as a library file), 'imported' (came from
   * this source before, not in the library now), 'twin' (another file on the source has the same
   * content) or 'new'. Drives and folders are compared by content; phones by size + name/date
   * (files of a matching size but another name are compared by content after copying).
   */
  async classify(session, { items = [], hashOf, signal, onProgress } = {}) {
    const { source, candidates } = session
    const bySize = new Map()
    const byStem = new Map()
    for (const it of items) {
      if (!it?.size) continue
      let l = bySize.get(it.size)
      if (!l) bySize.set(it.size, (l = []))
      l.push(it)
      if (it.ext === 'jpg' || it.ext === 'jpeg') {
        const s = stemOf(it.name)
        let m = byStem.get(s)
        if (!m) byStem.set(s, (m = []))
        m.push(it)
      }
    }
    const files = source.kind !== 'device'
    // the source's own repeats: candidates sharing a size
    const sizeCount = new Map()
    for (const c of candidates) sizeCount.set(c.size, (sizeCount.get(c.size) ?? 0) + 1)

    // 1. dates (files: read from the files themselves; phones: what the Shell reported)
    const needsWork = files ? candidates : []
    let done = 0
    const total = needsWork.length
    let lastTick = 0
    const tick = () => {
      done++
      const now = Date.now()
      if (now - lastTick > 150 || done === total) {
        lastTick = now
        onProgress?.({ phase: 'checking', done, total })
      }
    }
    await pool(needsWork, 4, async (c) => {
      if (signal?.aborted) return
      c.taken = await readTaken(c.path, c.ext)
      const libs = bySize.get(c.size)
      if (libs || sizeCount.get(c.size) > 1) {
        try {
          c.hash = await contentHash(c.path, c.size)
        } catch (err) {
          session.errors.push(`${c.name}: ${err.message}`)
        }
      }
      if (libs && c.hash) {
        for (const lib of libs) {
          if ((await this.libraryHash(lib, hashOf)) === c.hash) {
            c.status = 'library'
            c.match = lib.path
            break
          }
        }
      }
      tick()
    })
    if (signal?.aborted) throw abortError()

    for (const c of candidates) {
      if (!files) {
        const libs = bySize.get(c.size)
        if (libs) {
          const lib = libs.find((l) => l.name.toLowerCase() === c.name.toLowerCase() || near(l.mtime, c.mtime) || near(l.taken, c.taken))
          if (lib) {
            c.status = 'library'
            c.match = lib.path
            c.likely = true
          } else c.check = true
        }
      }
      // a HEIC converted to JPG by an earlier import: same name, same date taken (without one, the
      // same file date: the JPG gets the HEIC's)
      if (c.status === 'new' && isHeicExt(c.ext)) {
        const dated = Number.isFinite(c.taken)
        const lib = byStem.get(stemOf(c.name))?.find((l) => (dated ? near(l.taken, c.taken) : !Number.isFinite(l.taken) && near(l.mtime, c.mtime)))
        if (lib) {
          c.status = 'library'
          c.match = lib.path
          c.likely = true
        }
      }
      if (c.status === 'new' && this.memory.has(source.id, c.key)) c.status = 'imported'
    }

    // repeats on the source itself (drives and folders: by content)
    if (files) {
      const seen = new Set()
      for (const c of candidates) {
        if (!c.hash || c.status === 'library') continue
        if (seen.has(c.hash)) c.status = 'twin'
        else seen.add(c.hash)
      }
    }
  }

  /** What the view shows (matches ImportScan in ImportView.tsx). */
  summary(session) {
    const counts = { total: 0, new: 0, newBytes: 0, library: 0, imported: 0, importedBytes: 0, twins: 0, skipped: 0, heic: 0, videos: 0 }
    let first = Infinity
    let last = -Infinity
    const items = []
    for (const c of session.candidates) {
      counts.total++
      c.date = organize.bestDate(c)
      if (c.status === 'new') {
        counts.new++
        counts.newBytes += c.size
      } else if (c.status === 'library') counts.library++
      else if (c.status === 'imported') {
        counts.imported++
        counts.importedBytes += c.size
      } else if (c.status === 'twin') counts.twins++
      if (c.status === 'new' || c.status === 'imported') {
        if (isHeicExt(c.ext)) counts.heic++
        if (c.type === 'video') counts.videos++
        first = Math.min(first, c.date)
        last = Math.max(last, c.date)
      }
      items.push({ id: c.id, name: c.name, rel: c.rel, size: c.size, date: c.date, type: c.type, ext: c.ext, status: c.status, match: c.match ?? undefined, likely: c.likely || undefined })
    }
    items.sort((a, b) => b.date - a.date)
    const skippedTypes = [...session.skipped].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count)
    counts.skipped = skippedTypes.reduce((s, t) => s + t.count, 0)
    return {
      scanId: session.scanId,
      source: session.source,
      items,
      counts,
      skippedTypes,
      range: counts.new + counts.imported ? { first, last } : null,
      thumbs: session.source.kind !== 'device',
      roots: session.roots,
      errors: session.errors.slice(0, 50),
    }
  }

  /** Candidates an import would copy. options: { skipImported, ids? } */
  selection(session, { skipImported = DEFAULTS.skipImported, ids } = {}) {
    const only = Array.isArray(ids) && ids.length ? new Set(ids) : null
    return session.candidates.filter((c) => (c.status === 'new' || (c.status === 'imported' && !skipImported)) && (!only || only.has(c.id)))
  }

  sessionFor(scanId) {
    const s = this.session
    if (!s || s.scanId !== scanId) throw new Error('Look through the device again: it has changed since.')
    return s
  }

  /** How an import would go with these options: { count, bytes, heic, folders, preview: [{ folder, count }] }. */
  plan(scanId, options = {}) {
    const session = this.sessionFor(scanId)
    const o = { ...DEFAULTS, ...options }
    const list = this.selection(session, o)
    const dest = o.destination
    const moves = dest ? list.map((c) => ({ to: path.join(datedFolder(dest, organize.bestDate(c), o.folderPattern, o.locale), c.name) })) : []
    return {
      count: list.length,
      bytes: list.reduce((s, c) => s + c.size, 0),
      heic: list.filter((c) => isHeicExt(c.ext)).length,
      ...(dest ? organize.folderPreview(moves, dest, 6) : { folders: 0, preview: [] }),
    }
  }

  /** A thumbs.cjs item for a drive/folder candidate's preview (null for phones). */
  thumbItem(id) {
    const c = this.session?.byId.get(id)
    if (!c?.path) return null
    return { id: `imp${c.id}`, path: c.path, name: c.name, dir: path.dirname(c.path), ext: c.ext, type: c.type, mtime: c.mtime, size: c.size }
  }

  /**
   * Copies the new files. options:
   *   destination (required), folderPattern, locale?, skipImported, ids? (only these candidates),
   *   convertHeic, heicOriginals: 'aside' | 'next' | 'none', originalsDir (for 'aside'), quality,
   *   heicSource(item) → full-size picture (thumbs.source), deleteAfter (drives/folders only),
   *   trash?(path) for removing originals from a folder source (unlink is used for cards),
   *   items?, hashOf? (library, for phones: content check after copying),
   *   signal?, onProgress?(ImportProgress), onFile?(path) (just before a file appears in the library)
   * Resolves to { imported, bytes, converted, removed, alreadyHad, errors, warnings, cancelled,
   *               destination, files, entry } — `entry` is the History entry (null if nothing came in).
   */
  async run(scanId, options = {}) {
    if (this.busy) throw new Error(`Pics is still ${this.busy}.`)
    const session = this.sessionFor(scanId)
    const o = { ...DEFAULTS, ...options }
    if (!o.destination || !path.isAbsolute(o.destination)) throw new Error('Choose where the photos go first.')
    if (!HEIC_ORIGINALS.includes(o.heicOriginals)) o.heicOriginals = DEFAULTS.heicOriginals
    this.busy = 'importing'
    const { source } = session
    const dest = trimSep(path.resolve(o.destination)) + (/^[a-z]:$/i.test(trimSep(o.destination)) ? '\\' : '')
    const list = this.selection(session, o)
    const totalBytes = list.reduce((s, c) => s + c.size, 0)
    const res = {
      imported: 0, bytes: 0, converted: 0, removed: 0, alreadyHad: 0,
      errors: [], warnings: [], cancelled: false, destination: dest, files: [], entry: null,
    }
    const records = [] // { c, rec: History file, kept: path of the full copy of the original, hash }
    let bytesDone = 0
    let lastProgress = 0
    const progress = (phase, done, total, name, force = true) => {
      const now = Date.now()
      if (!force && now - lastProgress < 200) return
      lastProgress = now
      o.onProgress?.({ phase, done, total, bytes: bytesDone, totalBytes, name })
    }
    const cancelled = () => o.signal?.aborted

    let index = null
    const runFiles = new Map() // size → [{ to, hash }] copied in this run (phones: repeats are found after copying)
    const staging = path.join(dest, `${STAGING}-${crypto.randomBytes(4).toString('hex')}`)
    try {
      await fsp.mkdir(dest, { recursive: true })
      if (source.kind === 'device') index = sizeIndex(o.items ?? [])

      // 1. copy
      for (let i = 0; i < list.length; i++) {
        const c = list[i]
        if (cancelled()) break
        progress('copying', i, list.length, c.name)
        try {
          const out =
            source.kind === 'device'
              ? await this.copyFromDevice(session, c, dest, staging, i, o, { index, runFiles })
              : await this.copyFromFile(c, dest, o, (n) => {
                  bytesDone += n
                  progress('copying', i, list.length, c.name, false)
                })
          if (source.kind === 'device') bytesDone += c.size
          if (out.skipped) {
            res.alreadyHad++
            c.status = out.skipped
            continue
          }
          if (out.warning) res.warnings.push(out.warning)
          const rec = { from: source.kind === 'device' ? `${source.name}\\${c.rel}` : c.path, to: out.to, size: out.size, key: c.key }
          records.push({ c, rec, kept: out.to, hash: out.hash ?? null })
          res.files.push(rec)
          res.imported++
          res.bytes += out.size
          c.status = 'library'
          c.match = out.to
        } catch (err) {
          if (err?.name === 'AbortError' || cancelled()) break
          if (source.kind === 'device' && /no longer connected/i.test(err?.message ?? '')) {
            const left = list.length - i
            res.errors.push(`${source.name} isn't connected any more: ${plural(left, 'file')} ${left === 1 ? "wasn't" : "weren't"} copied. Connect it again and import the rest.`)
            break
          }
          res.errors.push(`${c.name}: ${err?.message ?? err}`)
        }
      }
      progress('copying', list.length, list.length, '')

      // 2. HEIC → JPG
      if (o.convertHeic && !cancelled()) {
        const heics = records.filter((r) => isHeicExt(extOf(r.rec.to)))
        let done = 0
        await pool(heics, 3, async (r) => {
          if (cancelled()) return
          progress('converting', done, heics.length, r.c.name)
          try {
            if (await this.convertOne(r, res, o, dest)) res.converted++
          } catch (err) {
            res.errors.push(`${r.c.name}: couldn't convert to JPG (${err?.message ?? err}); kept the HEIC`)
          }
          progress('converting', ++done, heics.length, r.c.name)
        })
      }

      // 3. remove the originals from the card (only copies that match the original byte for byte,
      //    all of it compared, whatever the size)
      if (o.deleteAfter && source.canDelete && source.kind !== 'device' && !cancelled()) {
        const removable = records.filter((r) => r.kept && r.c.path)
        let done = 0
        for (const r of removable) {
          if (cancelled()) break
          progress('removing', done++, removable.length, r.c.name)
          try {
            if (!(await sameContent(r.c.path, r.kept, o.signal))) {
              res.errors.push(`${r.c.name}: left on ${source.name} (the copy doesn't match the original)`)
              continue
            }
            if (source.kind === 'folder' && o.trash) await o.trash(r.c.path)
            else await fsp.unlink(r.c.path)
            res.removed++
            // Pics now holds the only copies: undoing the import must never recycle them
            r.rec.sourceRemoved = true
            if (r.jpg) r.jpg.sourceRemoved = true
          } catch (err) {
            if (err?.name === 'AbortError' || cancelled()) break
            res.errors.push(`${r.c.name}: couldn't remove it from ${source.name}: ${err?.message ?? err}`)
          }
        }
        progress('removing', removable.length, removable.length, '')
      }
    } finally {
      res.cancelled = !!cancelled()
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
      // remembered: everything now known to be in the library (imported, or there already)
      this.memory.add(source, session.candidates.filter((c) => c.status === 'library' || c.status === 'twin').map((c) => c.key))
      Object.assign(session.source, this.memory.info(source.id))
      this.busy = null
    }

    if (res.files.length) {
      const notes = [`From ${source.name}`]
      if (res.converted) notes.push(`${plural(res.converted, 'HEIC photo')} converted to JPG`)
      if (res.removed) notes.push(`${plural(res.removed, 'file')} removed from ${source.name} after copying`)
      res.entry = {
        kind: 'imported',
        destination: dest,
        note: notes.join(' · '),
        source: { id: source.id, name: source.name, kind: source.kind },
        removedOriginals: res.removed,
        files: res.files,
      }
    }
    return res
  }

  /** Copies one drive/folder file into its dated folder. Resolves to { to, size } or throws. */
  async copyFromFile(c, dest, o, onBytes) {
    const folder = datedFolder(dest, organize.bestDate(c), o.folderPattern, o.locale)
    await fsp.mkdir(folder, { recursive: true })
    let target = uniquePath(path.join(folder, c.name))
    const temp = `${target}${TEMP_SUFFIX}`
    await fsp.rm(temp, { force: true }) // a leftover from an import that was cut off
    try {
      if (c.size >= STREAM_COPY_MIN) {
        const input = fs.createReadStream(c.path, { highWaterMark: 4 * 1024 * 1024 })
        input.on('data', (chunk) => onBytes(chunk.length))
        await pipeline(input, fs.createWriteStream(temp, { flags: 'wx' }), { signal: o.signal })
      } else {
        await fsp.copyFile(c.path, temp, fs.constants.COPYFILE_EXCL)
        onBytes(c.size)
      }
      const st = await fsp.stat(temp)
      if (st.size !== c.size) throw new Error(`the copy has ${st.size} bytes instead of ${c.size}`)
      await fsp.utimes(temp, new Date(), new Date(c.mtime))
      if (exists(target)) target = uniquePath(target) // appeared while copying
      o.onFile?.(target)
      await fsp.rename(temp, target)
      return { to: target, size: st.size }
    } catch (err) {
      await fsp.rm(temp, { force: true }).catch(() => {})
      throw err
    }
  }

  /**
   * Copies one phone file: CopyHere into its own staging folder, then checks it (size, content
   * against same-size library files and earlier copies in this run) and moves it into its dated
   * folder. Resolves to { to, size, hash?, warning? } or { skipped: 'library' | 'twin' }.
   */
  async copyFromDevice(session, c, dest, staging, n, o, { index, runFiles }) {
    const stage = path.join(staging, String(n))
    const got = await this.deviceAgent().request('copy', { root: session.source.path, rel: c.rel, dest: stage, size: c.size }, { signal: o.signal })
    const staged = String(got.path)
    try {
      const st = await fsp.stat(staged)
      let warning = null
      // Shorter than the phone listed: the transfer was cut off (the phone locked or went to sleep).
      // It isn't imported or remembered; the staged part is deleted below.
      if (c.size && st.size < c.size)
        throw new Error(`the copy stopped early (${st.size.toLocaleString()} of ${c.size.toLocaleString()} bytes; the phone may have locked). Keep the phone unlocked and import again.`)
      if (c.size && st.size !== c.size) warning = `${c.name}: the phone listed ${c.size.toLocaleString()} bytes, the copy has ${st.size.toLocaleString()} (phones that convert photos while copying do this)`
      const taken = await readTaken(staged, c.ext)
      if (taken) c.taken = taken
      // same content as a library file, or as a file already copied in this run? (only files of
      // the same size can be, so most files are never hashed)
      let hash = null
      const libs = index.get(st.size)
      const earlier = runFiles.get(st.size)
      if (libs || earlier) {
        hash = await contentHash(staged, st.size)
        for (const e of earlier ?? []) {
          e.hash ??= await contentHash(e.to, st.size).catch(() => null)
          if (e.hash === hash) return { skipped: 'twin' }
        }
        for (const lib of libs ?? []) {
          if ((await this.libraryHash(lib, o.hashOf)) === hash) {
            c.match = lib.path
            return { skipped: 'library' }
          }
        }
      }
      const folder = datedFolder(dest, organize.bestDate(c), o.folderPattern, o.locale)
      await fsp.mkdir(folder, { recursive: true })
      let target = uniquePath(path.join(folder, c.name))
      if (validDate(c.mtime)) await fsp.utimes(staged, new Date(), new Date(c.mtime)).catch(() => {})
      if (exists(target)) target = uniquePath(target)
      o.onFile?.(target)
      await moveFile(staged, target)
      let same = runFiles.get(st.size)
      if (!same) runFiles.set(st.size, (same = []))
      same.push({ to: target, hash })
      return { to: target, size: st.size, hash, warning }
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Converts one imported HEIC; updates its History record(s). Resolves to true when converted. */
  async convertOne(r, res, o, dest) {
    const heic = r.rec.to
    const { taken, meta } = await readPhoto(heic)
    const item = { path: heic, name: path.basename(heic), dir: path.dirname(heic), ext: extOf(heic), type: 'image', taken: taken ?? r.c.taken ?? null, meta, mtime: r.c.mtime, size: r.rec.size }
    const source = o.heicSource ? await o.heicSource(item) : heic
    const aside = o.heicOriginals === 'aside' && o.originalsDir
    const out = await organize.convertHeicToJpeg(item, source, { quality: o.quality, originalsDir: aside ? o.originalsDir : null, roots: [dest] })
    o.onFile?.(out.file.to)
    const jpg = { from: r.rec.from, to: out.file.to, size: out.file.size, key: r.rec.key }
    res.files.push(jpg)
    r.jpg = jpg
    if (out.moveError) res.errors.push(out.moveError)
    if (out.keptOriginal) {
      // the JPG isn't the whole picture (a panorama over 8192 px): the HEIC stays next to it
      res.warnings.push(out.keptOriginal)
    } else if (out.moved) {
      r.rec.to = out.moved.to // the HEIC original, kept aside (outside the scanned folders)
      r.kept = out.moved.to
    } else if (o.heicOriginals === 'none') {
      // the original stays on the phone or card; Pics keeps only the JPG
      await fsp.unlink(heic)
      res.files.splice(res.files.indexOf(r.rec), 1)
      r.kept = null
    }
    return true
  }

  /**
   * Undoes an import: the copies go to the Recycle Bin (`trash(path)`, i.e. shell.trashItem) and
   * are forgotten, so a later import offers them again. Empty dated folders it made are removed.
   * Kept (never recycled): copies whose original was removed from the card after copying (they
   * are the only ones left: `sourceRemoved`, or every file of an older entry that removed
   * originals), and files that aren't the imported copy any more (another size now). Their
   * number is set as `entry.keptOnUndo`. Marks undone files `restored`; resolves to how many.
   */
  async undo(entry, trash) {
    let n = 0
    let kept = 0
    const dirs = new Set()
    const forgot = []
    // Entries from before `sourceRemoved` existed only say so in their note.
    const removedUnknown = entry.removedOriginals === undefined && /removed from .+ after copying/.test(String(entry.note ?? ''))
    for (const f of entry.files ?? []) {
      if (f.restored || !f.to) continue
      let st
      try {
        st = await fsp.stat(f.to)
      } catch (err) {
        if (err?.code === 'ENOENT') f.restored = true // gone already
        continue
      }
      if (f.sourceRemoved || removedUnknown || (Number.isFinite(f.size) && st.size !== f.size)) {
        kept++
        continue
      }
      try {
        await trash(f.to)
        f.restored = true
        dirs.add(path.dirname(f.to))
        if (f.key) forgot.push(f.key)
        n++
      } catch {}
    }
    entry.keptOnUndo = kept
    if (entry.source?.id && forgot.length) this.memory.forget(entry.source.id, forgot)
    for (const dir of dirs) {
      for (let d = dir, i = 0; i < 3 && entry.destination && isUnder(d, entry.destination) && trimSep(d).toLowerCase() !== trimSep(entry.destination).toLowerCase(); i++, d = path.dirname(d)) {
        try {
          if ((await fsp.readdir(d)).length) break
          await fsp.rmdir(d)
        } catch {
          break
        }
      }
    }
    return n
  }

  dispose() {
    this.memory.saveNow()
    this.lister?.kill()
    this.device?.kill()
  }
}

/** Runs an agent request again once if the PowerShell process died under it (list and scan are safe to repeat). */
async function retryOnce(fn, signal) {
  try {
    return await fn()
  } catch (err) {
    if (err?.code !== 'AGENT_EXIT' || signal?.aborted) throw err
    return fn()
  }
}

function sizeIndex(items) {
  const m = new Map()
  for (const it of items) {
    if (!it?.size) continue
    let l = m.get(it.size)
    if (!l) m.set(it.size, (l = []))
    l.push(it)
  }
  return m
}

/** Every file under `dir` (dot folders, system and recycle folders skipped). */
async function walkFiles(dir, out, onFound, signal, depth = 0) {
  if (signal?.aborted) return
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (depth < 24) await walkFiles(full, out, onFound, signal, depth + 1)
    } else if (e.isFile() && !e.name.endsWith(TEMP_SUFFIX)) {
      out.push(full)
      onFound()
    }
  }
}

module.exports = {
  Importer,
  ImportMemory,
  ShellAgent,
  DEFAULTS,
  DEVICE_FOLDERS,
  CARD_FOLDERS,
  STAGING,
  AGENT_PS,
  contentHash,
  memoryKey,
  sourcesFromList,
  driveSource,
  deviceSource,
  folderSource,
  datedFolder,
}
