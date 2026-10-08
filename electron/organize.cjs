const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { fromFileName } = require('./datetools.cjs')
const { uniquePath, moveFile, transferFiles, sidecarFinder, setFileDate, restoreMoves } = require('./cleanup.cjs')

/**
 * Organize (ported from DupeLens' OrganizeService + the Organize tab's fixes): fix file dates from
 * the dates in file names, sort into dated folders, rename by date, convert HEIC photos to JPG.
 * Planning is pure (no file is touched); the actions never overwrite anything and return what
 * History needs to undo them.
 */

const DAY = 86_400_000

// Settings defaults (DupeLens' AppSettings).
const DEFAULTS = {
  folderPattern: 'yyyy\\\\MM - MMMM',
  copy: false,
  renamePattern: 'yyyy-MM-dd HH.mm.ss',
  deviceNamesOnly: true,
  jpegQuality: 92,
  moveOriginals: true,
}

/** Folder patterns (.NET custom date formats; `\\` = a nested folder) and how they look. */
const FOLDER_PATTERNS = [
  { value: 'yyyy\\\\MM - MMMM', label: '2022\\12 - December' },
  { value: 'yyyy\\\\MM', label: '2022\\12' },
  { value: 'yyyy\\\\yyyy-MM-dd', label: '2022\\2022-12-16' },
  { value: 'yyyy-MM', label: '2022-12' },
  { value: 'yyyy', label: '2022' },
]

const NAME_PATTERNS = [
  { value: 'yyyy-MM-dd HH.mm.ss', label: '2022-12-16 14.30.05' },
  { value: 'yyyyMMdd_HHmmss', label: '20221216_143005' },
  { value: 'yyyy-MM-dd {name}', label: '2022-12-16 IMG-20221216-WA0037' },
]

/** Where HEIC originals go after converting (left out of scans by main.cjs). */
const HEIC_ORIGINALS = 'HEIC originals'

// Names produced by cameras, phones and messengers (worth renaming); anything else was probably named by hand.
const DEVICE_NAME = /^(IMG|VID|DSC|DSCN|DSCF|PXL|MVIMG|PANO|SAM|P\d|GOPR|DJI|MOV|Screenshot|Screen Shot|WhatsApp|\d{8})[\s_-]/i

const isDeviceName = (name) => DEVICE_NAME.test(name)
const isHeic = (item) => item.ext === 'heic' || item.ext === 'heif'

const exists = (p) => {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}
const trimSep = (p) => p.replace(/[\\/]+$/, '')
const samePath = (a, b) => trimSep(a).toLowerCase() === trimSep(b).toLowerCase()
/** `file` is inside `folder` (at any depth). */
const isUnder = (file, folder) => file.toLowerCase().startsWith(trimSep(folder).toLowerCase() + path.sep)
/** dir + name without path.join's normalising (slow on Windows); `dir` is already a clean path. */
const joinName = (dir, name) => (dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + path.sep + name)
const byPath = (a, b) => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

// ── Dates ──────────────────────────────────────────────────────────────────

// Name parsing per item, remembered while the item's name, file date and capture date stay the same
// (the Organize view re-plans on every option change).
const facts = new WeakMap()
function dateFacts(item) {
  let f = facts.get(item)
  if (!f || f.name !== item.name || f.mtime !== item.mtime || f.taken !== item.taken) {
    f = { name: item.name, mtime: item.mtime, taken: item.taken, fromName: fromFileName(item.name), info: null }
    facts.set(item, f)
  }
  return f
}

/**
 * Best guess of when the photo was taken, and whether its time of day is actually known:
 * the capture date (EXIF / video), else the date in the file name (with the file's time of day
 * when the name holds only the day), else the file date. Resolves to { date (ms), hasTime }.
 */
function bestDateInfo(item) {
  if (Number.isFinite(item.taken)) return { date: item.taken, hasTime: true }
  const memo = dateFacts(item)
  if (memo.info) return memo.info
  const f = memo.fromName
  if (f && f.hasTime) memo.info = { date: f.date, hasTime: true }
  else if (f) {
    const day = new Date(f.date)
    const m = new Date(item.mtime)
    day.setHours(m.getHours(), m.getMinutes(), m.getSeconds(), m.getMilliseconds())
    memo.info = { date: day.getTime(), hasTime: false }
  } else memo.info = { date: item.mtime, hasTime: true }
  return memo.info
}

const bestDate = (item) => bestDateInfo(item).date

// ── Live Photos ────────────────────────────────────────────────────────────

// The same rule as src/lib/live.ts pairLivePhotos: a still and a short clip side by side, same name.
const LIVE_STILLS = new Set(['heic', 'heif', 'jpg', 'jpeg'])
const LIVE_CLIPS = new Set(['mov', 'mp4'])
const LIVE_MAX_SECONDS = 6
const LIVE_MAX_BYTES = 12 * 1024 * 1024
const liveKey = (it) => `${it.dir}|${it.name.replace(/\.[^.]+$/, '')}`.toLowerCase()

/** Live Photo pairs among `items`: Map(clip → its still), so Organize keeps them together. */
function livePairs(items) {
  const stills = new Map()
  for (const it of items) if (it.type === 'image' && LIVE_STILLS.has(it.ext)) stills.set(liveKey(it), it)
  const stillOf = new Map()
  const paired = new Set()
  for (const it of items) {
    if (it.type !== 'video' || !LIVE_CLIPS.has(it.ext)) continue
    const short = it.duration ? it.duration <= LIVE_MAX_SECONDS : it.size <= LIVE_MAX_BYTES
    if (!short) continue
    const still = stills.get(liveKey(it))
    if (!still || paired.has(still)) continue
    paired.add(still)
    stillOf.set(it, still)
  }
  return stillOf
}

const startOfDay = (ms) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// ── Tiny .NET date formatter (yyyy, MM, MMMM, dd, HH, mm, ss, 'literal', \x) ──

// Month and weekday names per locale (12 + 7 of each style), from Intl.
const nameCache = new Map()
function intlName(locale, kind, style, d) {
  const index = kind === 'month' ? d.getMonth() : d.getDay()
  const key = `${locale ?? ''}|${kind}|${style}|${index}`
  let name = nameCache.get(key)
  if (name === undefined) {
    name = new Intl.DateTimeFormat(locale, { [kind]: style }).format(d)
    nameCache.set(key, name)
  }
  return name
}
const pad = (v, n) => String(v).padStart(n, '0')

/** Formats a date (ms, local time) with a .NET custom format string. Month/day names come from Intl. */
function formatDate(ms, pattern, locale) {
  const d = new Date(ms)
  let out = ''
  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i]
    if (c === '\\') {
      out += pattern[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const end = pattern.indexOf(c, i + 1)
      const stop = end < 0 ? pattern.length : end
      out += pattern.slice(i + 1, stop)
      i = stop + 1
      continue
    }
    let n = 1
    while (pattern[i + n] === c) n++
    switch (c) {
      case 'y':
        out += n <= 2 ? pad(d.getFullYear() % 100, n) : pad(d.getFullYear(), n)
        break
      case 'M':
        out += n >= 4 ? intlName(locale, 'month', 'long', d) : n === 3 ? intlName(locale, 'month', 'short', d) : pad(d.getMonth() + 1, n)
        break
      case 'd':
        out += n >= 4 ? intlName(locale, 'weekday', 'long', d) : n === 3 ? intlName(locale, 'weekday', 'short', d) : pad(d.getDate(), n)
        break
      case 'H':
        out += pad(d.getHours(), Math.min(n, 2))
        break
      case 'h':
        out += pad(d.getHours() % 12 || 12, Math.min(n, 2))
        break
      case 'm':
        out += pad(d.getMinutes(), Math.min(n, 2))
        break
      case 's':
        out += pad(d.getSeconds(), Math.min(n, 2))
        break
      default:
        out += pattern.slice(i, i + n)
    }
    i += n
  }
  return out
}

// ── Fix dates ──────────────────────────────────────────────────────────────

/**
 * Files with no capture date whose name holds a date that disagrees with the file date by more
 * than a day. Day-only names (WhatsApp) get noon. Returns [{ item, date }] sorted by path.
 */
function findDateFixes(items) {
  const fixes = []
  for (const item of items) {
    if (Number.isFinite(item.taken)) continue
    const f = dateFacts(item).fromName
    if (!f) continue
    const date = f.hasTime ? f.date : startOfDay(f.date) + 12 * 3_600_000
    // whole calendar days apart (rounded: a DST change makes a day 23 or 25 hours)
    if (Math.abs(Math.round((startOfDay(item.mtime) - startOfDay(date)) / DAY)) <= 1) continue
    fixes.push({ item, date })
  }
  return fixes.sort((a, b) => byPath(a.item.path, b.item.path))
}

/** Sets each file's modified date. Resolves to History files [{ from, oldMtime }] (failures are skipped). */
async function applyDateFixes(fixes) {
  const files = []
  for (const { item, date } of fixes) {
    try {
      const oldMtime = await setFileDate(item.path, date)
      files.push({ from: item.path, oldMtime })
    } catch {}
  }
  return files
}

// ── Sort into dated folders ────────────────────────────────────────────────

/**
 * Which files a folder sort touches: organizing a library folder (or a folder inside one) only
 * moves that folder's own files, so a backup folder is never merged in. A destination outside the
 * library folders collects files from all of them.
 */
function organizeSource(items, root, roots = []) {
  if (!root) return []
  const rootIsScanned = roots.some((r) => samePath(r, root) || isUnder(root, r))
  return rootIsScanned ? items.filter((it) => isUnder(it.path, root)) : items
}

/** The dated folder (absolute) for a date. `\` in the formatted pattern makes nested folders. */
function folderFor(root, date, pattern, locale) {
  const parts = formatDate(date, pattern, locale).split('\\').filter(Boolean)
  return path.join(root, ...parts)
}

/**
 * Planned moves [{ item, to, liveOf? }] into dated folders under `root`; files already in place are
 * left out. A Live Photo's clip goes where its still goes (`liveOf`: the still), whatever its own date.
 */
function planFolders(items, root, pattern, { locale } = {}) {
  const plan = []
  if (!root) return plan
  const stillOf = livePairs(items)
  const folders = new Map() // formatted date → [absolute folder, its lower-case form]
  for (const item of items) {
    const still = stillOf.get(item)
    const date = bestDate(still ?? item)
    const key = formatDate(date, pattern, locale)
    let folder = folders.get(key)
    if (!folder) {
      const abs = folderFor(root, date, pattern, locale)
      folder = [abs, trimSep(abs).toLowerCase()]
      folders.set(key, folder)
    }
    if (trimSep(item.dir).toLowerCase() === folder[1]) continue // already in place
    plan.push(still ? { item, to: joinName(folder[0], item.name), liveOf: still } : { item, to: joinName(folder[0], item.name) })
  }
  return plan
}

/** Preview of a folder plan: how many folders, and the first `limit` of them (relative to root) with counts. */
function folderPreview(plan, root, limit = 8) {
  const groups = new Map()
  for (const m of plan) {
    const dir = path.dirname(m.to)
    const key = dir.toLowerCase()
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { dir, count: 1 })
  }
  const sorted = [...groups.values()].sort((a, b) => byPath(a.dir, b.dir))
  return {
    folders: sorted.length,
    preview: sorted.slice(0, limit).map((g) => ({ folder: path.relative(root, g.dir) || '.', count: g.count })),
  }
}

// ── Rename by date ─────────────────────────────────────────────────────────

/** exists(p) backed by one directory listing per folder (much faster than a stat per file). */
function dirLister() {
  const dirs = new Map()
  return (p) => {
    const dir = path.dirname(p).toLowerCase()
    let names = dirs.get(dir)
    if (!names) {
      try {
        names = new Set(fs.readdirSync(path.dirname(p)).map((n) => n.toLowerCase()))
      } catch {
        names = new Set()
      }
      dirs.set(dir, names)
    }
    return names.has(path.basename(p).toLowerCase())
  }
}

/**
 * Planned renames [{ item, to, liveOf? }]. Files are named from their best date; when only the day
 * is known (e.g. WhatsApp) the original counter is kept instead of inventing a time. Clashes with
 * existing files or other planned names get " (2)", " (3)"… A Live Photo's clip gets its still's new
 * name (with its own extension and the same " (n)"; `liveOf`: the still), and is left as it is
 * when the still is.
 */
function planRenames(items, pattern, deviceNamesOnly, { exists: fileExists = dirLister() } = {}) {
  const plan = []
  const taken = new Set()
  const withName = pattern.includes('{name}')
  const compact = pattern.startsWith('yyyyMMdd')
  const stillOf = livePairs(items)
  const clipOf = new Map([...stillOf].map(([clip, still]) => [still, clip]))
  const dated = items.map((item) => ({ item, info: bestDateInfo(item) })).sort((a, b) => a.info.date - b.info.date)
  for (const { item, info } of dated) {
    if (stillOf.has(item)) continue // a Live Photo's clip is renamed with its still
    const ext = path.extname(item.name)
    const stem = path.basename(item.name, ext)
    if (deviceNamesOnly && !isDeviceName(item.name)) continue
    const { date, hasTime } = info
    let newStem
    if (withName) {
      newStem = formatDate(date, pattern.split('{name}').join("'{name}'")).split('{name}').join(stem)
    } else if (hasTime) {
      newStem = formatDate(date, pattern)
    } else {
      // Only the day is known (e.g. WhatsApp): keep the original counter instead of inventing a time.
      const dateOnly = formatDate(date, compact ? 'yyyyMMdd' : 'yyyy-MM-dd')
      const counter = stem.split(/[-_ ]/).pop()
      newStem = `${dateOnly}${compact ? '_' : ' '}${counter}`
    }
    if (newStem.toLowerCase() === stem.toLowerCase()) continue
    if (withName && stem.startsWith(formatDate(date, 'yyyy-MM-dd'))) continue

    const extOf = (it) => (it.ext ? `.${it.ext}` : path.extname(it.name).toLowerCase())
    const nameAt = (n, newExt) => joinName(item.dir, n === 1 ? newStem + newExt : `${newStem} (${n})${newExt}`)
    // free: not planned for another file, and not on disk (unless it's the file's own name)
    const free = (p, own) => !taken.has(p.toLowerCase()) && (p.toLowerCase() === own.path.toLowerCase() || !fileExists(p))
    const clip = clipOf.get(item)
    let n = 1
    while (!free(nameAt(n, extOf(item)), item) || (clip && !free(nameAt(n, extOf(clip)), clip))) n++
    const candidate = nameAt(n, extOf(item))
    const clipTo = clip ? nameAt(n, extOf(clip)) : null
    taken.add(candidate.toLowerCase())
    if (clipTo) taken.add(clipTo.toLowerCase())
    // Already named that (e.g. "<date> (2)" next to "<date>"): renaming it to itself would make it
    // "<date> (2) (2)", then back again, on every run.
    if (candidate.toLowerCase() === item.path.toLowerCase()) continue
    plan.push({ item, to: candidate })
    if (clipTo && clipTo.toLowerCase() !== clip.path.toLowerCase()) plan.push({ item: clip, to: clipTo, liveOf: item })
  }
  return plan
}

// ── Carry out a plan ───────────────────────────────────────────────────────

/**
 * Moves (or copies) files to their planned paths, never overwriting anything; an XMP sidecar
 * ("IMG_1.xmp" / "IMG_1.HEIC.xmp") goes along and is renamed to match, and a Live Photo's clip
 * (a move with `liveOf`) goes in the same step as its still, so both get the same " (n)" when the
 * name is taken. `signal` (AbortSignal) stops before the next file; what was done by then is
 * returned as usual.
 * Resolves to { files: [{ id, from, to, size, sidecar?: { from, to } }], errors: ["name: reason"] }
 * (a file that moved but whose sidecar couldn't is in `files`, with a note in `errors`).
 */
async function executePlan(moves, { copy = false, signal } = {}) {
  const files = []
  const errors = []
  const sidecars = sidecarFinder()
  // A Live Photo's clip (`liveOf`) moves in the same step as its still, with the same " (n)".
  const planned = new Set(moves.map((m) => m.item))
  const clipMove = new Map() // still → its clip's move
  for (const m of moves) if (m.liveOf && planned.has(m.liveOf) && !clipMove.has(m.liveOf)) clipMove.set(m.liveOf, m)
  const record = (item, res) => {
    const rec = { id: item.id, from: item.path, to: res.to, size: item.size }
    if (res.sidecar) rec.sidecar = res.sidecar
    if (res.note) errors.push(res.note)
    files.push(rec)
  }
  for (const m of moves) {
    if (signal?.aborted) break
    if (m.liveOf && clipMove.get(m.liveOf) === m) continue // goes with its still
    const { item, to } = m
    const clip = clipMove.get(item)
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true })
      if (clip) await fsp.mkdir(path.dirname(clip.to), { recursive: true })
      const list = [{ from: item.path, wanted: to }]
      if (clip) list.push({ from: clip.item.path, wanted: clip.to })
      const [res, clipRes] = await transferFiles(list, { copy, sidecars })
      record(item, res)
      if (clipRes?.error) errors.push(`${clip.item.name}: ${clipRes.error.message} (its photo ${item.name} was done without it)`)
      else if (clipRes) record(clip.item, clipRes)
    } catch (err) {
      errors.push(`${item.name}: ${err.message}`)
      if (clip) errors.push(`${clip.item.name}: left with its photo ${item.name}`)
    }
  }
  return { files, errors }
}

// ── HEIC → JPG ─────────────────────────────────────────────────────────────

function exifDate(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}:${pad(d.getMonth() + 1, 2)}:${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`
}

// EXIF stores degrees/minutes/seconds as three rationals.
function dms(value) {
  const v = Math.abs(value)
  const deg = Math.floor(v)
  const minFull = (v - deg) * 60
  const min = Math.floor(minFull)
  const sec = Math.round((minFull - min) * 60 * 1000)
  return `${deg}/1 ${min}/1 ${sec}/1000`
}

/** EXIF for a converted photo: date taken, camera, exposure and place, from the library item. */
function exifFor(item) {
  const meta = item.meta ?? {}
  const ifd0 = {}
  const exif = {}
  if (meta.make) ifd0.Make = String(meta.make)
  if (meta.model) ifd0.Model = String(meta.model)
  if (Number.isFinite(item.taken)) {
    exif.DateTimeOriginal = exifDate(item.taken)
    exif.DateTimeDigitized = exifDate(item.taken)
  }
  if (meta.exposure > 0)
    exif.ExposureTime = meta.exposure < 1 ? `1/${Math.round(1 / meta.exposure)}` : `${Math.round(meta.exposure * 10)}/10`
  if (meta.f > 0) exif.FNumber = `${Math.round(meta.f * 100)}/100`
  if (meta.iso > 0) exif.ISOSpeedRatings = String(Math.min(Math.round(meta.iso), 65535))
  if (meta.focal > 0) exif.FocalLength = `${Math.round(meta.focal * 100)}/100`
  if (meta.lens) exif.LensModel = String(meta.lens)
  const out = {}
  if (Object.keys(ifd0).length) out.IFD0 = ifd0
  if (Object.keys(exif).length) out.IFD2 = exif
  if (Number.isFinite(meta.lat) && Number.isFinite(meta.lon)) {
    out.IFD3 = {
      GPSLatitudeRef: meta.lat >= 0 ? 'N' : 'S',
      GPSLatitude: dms(meta.lat),
      GPSLongitudeRef: meta.lon >= 0 ? 'E' : 'W',
      GPSLongitude: dms(meta.lon),
    }
  }
  return out
}

// Paths claimed by conversions still running, so two at once never pick the same free name.
const claimed = new Set()
function claim(target) {
  let p = uniquePath(target)
  if (claimed.has(p.toLowerCase())) {
    const dir = path.dirname(target)
    const ext = path.extname(target)
    const stem = path.basename(target, ext)
    for (let n = 2; claimed.has(p.toLowerCase()) || exists(p); n++) p = path.join(dir, `${stem} (${n})${ext}`)
  }
  claimed.add(p.toLowerCase())
  return p
}

/** Where a HEIC original goes inside the originals folder: its path relative to its library folder. */
function originalTarget(item, originalsDir, roots) {
  const root = roots.find((r) => isUnder(item.path, r))
  let relative = root ? path.relative(root, item.dir) : ''
  // Files from the 2nd, 3rd… library folder go under that folder's name, so nothing gets mixed up.
  if (root && roots.length > 1 && !samePath(root, roots[0])) relative = path.join(path.basename(trimSep(root)), relative)
  return path.join(originalsDir, relative, item.name)
}

/**
 * The HEIC's own picture size ({ width, height }) from its header (workers.cjs' heifSize), else from
 * its EXIF; null when neither can tell.
 */
async function heicSize(file) {
  try {
    const size = await require('./workers.cjs').heifSize(file)
    if (size?.width && size?.height) return size
  } catch {}
  try {
    const d = await require('exifr').parse(file, { tiff: true, exif: true, gps: false, xmp: false, icc: false, iptc: false, ifd1: false })
    const width = d?.ExifImageWidth ?? d?.ImageWidth
    const height = d?.ExifImageHeight ?? d?.ImageHeight
    if (width > 0 && height > 0) return { width, height }
  } catch {}
  return null
}

/**
 * Converts one HEIC photo to a JPG next to it (same name, .jpg; " (2)" if taken). `source` is the
 * full-size picture: a file path sharp can read or a JPEG/PNG buffer (thumbs.source(item) — Windows
 * renders HEIC). The JPG is upright, keeps the date taken, camera, exposure and place, and gets the
 * original's file dates. With `originalsDir`, the HEIC then moves there, keeping its folder
 * structure relative to its library folder (`roots`).
 *
 * Windows renders at most 8192 px, so a bigger HEIC (a panorama) gives a smaller JPG; when the JPG
 * is smaller than the HEIC (or its size can't be checked), the HEIC stays where it is and
 * `keptOriginal` says why — callers must not move or delete it then.
 *
 * Resolves to { file: { from, to, size }, moved: { from, to, size } | null, moveError: string | null,
 * keptOriginal: string | null }. Throws when the JPG can't be made (nothing changed then).
 */
async function convertHeicToJpeg(item, source, { quality = DEFAULTS.jpegQuality, originalsDir = null, roots = [] } = {}) {
  if (!source) throw new Error("This photo can't be opened")
  const sharp = require('sharp')
  const st = await fsp.stat(item.path)
  const ext = path.extname(item.name)
  const target = claim(path.join(item.dir, `${path.basename(item.name, ext)}.jpg`))
  const temp = `${target}.lumen.tmp`
  let file
  let made
  try {
    made = await sharp(source, { failOn: 'none' })
      .rotate() // upright pixels (EXIF orientation, if the source has one)
      .keepIccProfile()
      .withExif(exifFor(item))
      .jpeg({ quality: Math.min(100, Math.max(50, Math.round(quality))) })
      .toFile(temp)
    if (exists(target)) throw new Error(`${path.basename(target)} appeared while converting`)
    await fsp.rename(temp, target)
    await fsp.utimes(target, st.atime, st.mtime)
    file = { from: item.path, to: target, size: (await fsp.stat(target)).size }
  } catch (err) {
    await fsp.unlink(temp).catch(() => {})
    throw err
  } finally {
    claimed.delete(target.toLowerCase())
  }

  // Is the JPG the whole picture? (long sides compared, so either orientation of the sizes works)
  const real = await heicSize(item.path)
  const jpgLong = Math.max(made?.width || 0, made?.height || 0)
  let keptOriginal = null
  if (!real) keptOriginal = `${item.name}: converted, but the HEIC was kept where it is (Lumen couldn't check that the JPG has its full size)`
  else if (jpgLong + 1 < Math.max(real.width, real.height))
    keptOriginal = `${item.name}: the JPG is smaller (${made.width} × ${made.height}) than the HEIC (${real.width} × ${real.height}), so the HEIC was kept where it is`
  if (keptOriginal) return { file, moved: null, moveError: null, keptOriginal }

  if (!originalsDir) return { file, moved: null, moveError: null, keptOriginal: null }
  let to = null
  try {
    const wanted = originalTarget(item, originalsDir, roots)
    await fsp.mkdir(path.dirname(wanted), { recursive: true })
    to = claim(wanted)
    await moveFile(item.path, to)
    return { file, moved: { from: item.path, to, size: item.size }, moveError: null, keptOriginal: null }
  } catch (err) {
    return { file, moved: null, moveError: `${item.name} was converted but not moved: ${err.message}`, keptOriginal: null }
  } finally {
    if (to) claimed.delete(to.toLowerCase())
  }
}

const near = (a, b, ms = 2000) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= ms

/**
 * A JPG next to the HEIC with its name that is the same photo (same date taken; without dates, the
 * same file date — a converted JPG gets the HEIC's): it was converted before (e.g. with "Keep next
 * to the JPGs"). `jpgs`: { taken, mtime } of such JPGs.
 */
const sameShot = (heic, jpgs) =>
  jpgs.some((j) => (Number.isFinite(heic.taken) && Number.isFinite(j.taken) ? near(heic.taken, j.taken) : near(heic.mtime, j.mtime)))

/** "IMG_1 (2).jpg" → "img_1": the name a JPG had before " (2)" was added to make it free. */
const baseStem = (name) => path.basename(name, path.extname(name)).replace(/ \(\d+\)$/, '').toLowerCase()
const isJpgName = (name) => /\.jpe?g$/i.test(name)

/** A folder's JPGs by lower-case name stem, each also under its stem without " (2)": Map(stem → [names]). */
async function jpgIndex(dir) {
  const index = new Map()
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!isJpgName(name)) continue
    for (const stem of new Set([path.basename(name, path.extname(name)).toLowerCase(), baseStem(name)])) {
      let list = index.get(stem)
      if (!list) index.set(stem, (list = []))
      list.push(name)
    }
  }
  return index
}

/**
 * Has this HEIC been converted already (a matching JPG — "IMG_1.jpg", or "IMG_1 (2).jpg" when the
 * name was taken — sits next to it on disk)? `indexOf(dir)` → jpgIndex(dir), read once per run.
 */
async function convertedBefore(item, indexOf) {
  const stem = path.basename(item.name, path.extname(item.name)).toLowerCase()
  const jpgs = []
  for (const name of (await indexOf(item.dir)).get(stem) ?? []) {
    const p = joinName(item.dir, name)
    let st
    try {
      st = await fsp.stat(p)
    } catch {
      continue
    }
    let taken = null
    if (Number.isFinite(item.taken)) {
      try {
        const d = await require('exifr').parse(p, { pick: ['DateTimeOriginal', 'CreateDate'] })
        const t = d?.DateTimeOriginal ?? d?.CreateDate
        if (t instanceof Date && Number.isFinite(t.getTime())) taken = t.getTime()
      } catch {}
    }
    jpgs.push({ taken, mtime: st.mtimeMs })
  }
  return jpgs.length > 0 && sameShot(item, jpgs)
}

/**
 * Converts many HEIC photos. `getSource(item)` resolves to the full-size picture (thumbs.source).
 * HEICs that already have their JPG next to them are skipped. `signal` (AbortSignal) stops before
 * the next photo; what was converted by then is returned as usual.
 * Resolves to { files, movedOriginals, errors, skipped, entry } where `entry` is the History entry to
 * add (null when nothing was converted).
 */
async function convertHeicFiles(items, getSource, { quality, originalsDir = null, roots = [], concurrency = 4, onProgress, signal } = {}) {
  const files = []
  const movedOriginals = []
  const errors = []
  let skipped = 0
  let next = 0
  let started = 0
  // each folder's JPGs, listed once
  const indexes = new Map()
  const indexOf = (dir) => {
    const key = dir.toLowerCase()
    if (!indexes.has(key)) indexes.set(key, jpgIndex(dir))
    return indexes.get(key)
  }
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next++]
      onProgress?.(++started, items.length)
      try {
        if (await convertedBefore(item, indexOf)) {
          skipped++
          continue
        }
        const res = await convertHeicToJpeg(item, await getSource(item), { quality, originalsDir, roots })
        files.push(res.file)
        if (res.moved) movedOriginals.push(res.moved)
        if (res.moveError) errors.push(res.moveError)
        if (res.keptOriginal) errors.push(res.keptOriginal)
      } catch (err) {
        errors.push(`${item.name}: ${err?.message ?? err}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker))
  const entry = files.length
    ? { kind: 'converted', destination: movedOriginals.length ? originalsDir : undefined, files, movedOriginals }
    : null
  return { files, movedOriginals, errors, skipped, entry }
}

/**
 * Undoes a conversion: originals go back first, then the JPGs made from them go to the Recycle Bin
 * (only where the original is back in place, so a photo is never lost). `trash(path)` sends one file
 * to the Recycle Bin (shell.trashItem). Marks undone files `restored`; resolves to how many.
 */
async function undoConversion(entry, trash) {
  await restoreMoves(entry.movedOriginals ?? [])
  const safe = entry.files.filter((f) => !f.restored && f.to && exists(f.from) && exists(f.to))
  for (const f of safe) {
    try {
      await trash(f.to)
    } catch {
      // whatever was recycled is counted below
    }
  }
  const undone = safe.filter((f) => !exists(f.to))
  for (const f of undone) f.restored = true
  return undone.length
}

// ── Everything the Organize view shows ─────────────────────────────────────

/**
 * The Organize view's data (matches `OrganizePlan` in src/components/OrganizeView.tsx).
 * opts: { root, roots, folderPattern, renamePattern, deviceNamesOnly, skip (ids selected for removal),
 *         isUnreadable(item)?, locale? }
 */
function summarize(items, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const skip = o.skip instanceof Set ? o.skip : new Set(o.skip ?? [])
  const kept = skip.size ? items.filter((it) => !skip.has(it.id)) : items

  const fixes = findDateFixes(items)
  const folderPlan = o.root ? planFolders(organizeSource(kept, o.root, o.roots ?? []), o.root, o.folderPattern, { locale: o.locale }) : []
  const renames = planRenames(kept, o.renamePattern, o.deviceNamesOnly)
  const heic = items.filter(isHeic)
  const unreadable = o.isUnreadable ? heic.filter((it) => o.isUnreadable(it)).length : 0
  // JPGs by folder + name ("IMG_1 (2).jpg" also as IMG_1's), so HEICs converted before (their JPG
  // kept next to them) aren't offered again
  const jpgs = new Map()
  if (heic.length) {
    for (const it of items) {
      if (it.ext !== 'jpg' && it.ext !== 'jpeg') continue
      const dir = trimSep(it.dir).toLowerCase()
      const own = path.basename(it.name, path.extname(it.name)).toLowerCase()
      for (const stem of new Set([own, baseStem(it.name)])) {
        let list = jpgs.get(`${dir}|${stem}`)
        if (!list) jpgs.set(`${dir}|${stem}`, (list = []))
        list.push(it)
      }
    }
  }
  const converted = (it) => {
    const list = jpgs.get(`${trimSep(it.dir).toLowerCase()}|${path.basename(it.name, path.extname(it.name)).toLowerCase()}`)
    return !!list && sameShot(it, list)
  }
  const convertible = heic.filter((it) => !skip.has(it.id) && !(o.isUnreadable && o.isUnreadable(it)) && !converted(it))

  return {
    dateFixes: {
      count: fixes.length,
      preview: fixes.slice(0, 6).map((f) => ({ name: f.item.name, from: f.item.mtime, to: f.date })),
    },
    folders: { root: o.root ?? '', count: folderPlan.length, ...folderPreview(folderPlan, o.root ?? '', 8) },
    renames: {
      count: renames.length,
      preview: renames.slice(0, 6).map((m) => ({ from: m.item.name, to: path.basename(m.to) })),
    },
    heic: { count: convertible.length, bytes: convertible.reduce((s, it) => s + (it.size || 0), 0), unreadable },
  }
}

module.exports = {
  DEFAULTS,
  FOLDER_PATTERNS,
  NAME_PATTERNS,
  HEIC_ORIGINALS,
  isDeviceName,
  isHeic,
  isUnder,
  bestDateInfo,
  bestDate,
  formatDate,
  findDateFixes,
  applyDateFixes,
  organizeSource,
  planFolders,
  folderPreview,
  planRenames,
  executePlan,
  exifFor,
  convertHeicToJpeg,
  convertHeicFiles,
  undoConversion,
  summarize,
}
