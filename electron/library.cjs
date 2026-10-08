const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const exifr = require('exifr')
const { EXIFR_OPTIONS: XMP_OPTIONS, fromExifr, fromMoov } = require('./xmp.cjs')

const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico',
  'heic', 'heif', 'tif', 'tiff', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2',
])
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', '3gp', 'mts', 'm2ts', 'mpg', 'mpeg'])
const EXIF_EXT = new Set(['jpg', 'jpeg', 'jfif', 'heic', 'heif', 'tif', 'tiff', 'dng', 'avif', 'webp', 'png'])
const MP4_EXT = new Set(['mp4', 'm4v', 'mov', '3gp'])
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', 'appdata', '__macosx'])

/**
 * File types the user can include or skip (Settings → Skip during scans), grouped the way people
 * think of them (from DupeLens' FileTypes). Every extension Lumen reads is in exactly one group.
 */
const FILE_TYPES = [
  { key: 'jpeg', label: 'JPEG photos', extensions: ['jpg', 'jpeg', 'jfif'], video: false },
  { key: 'heic', label: 'HEIC (iPhone) photos', extensions: ['heic', 'heif'], video: false },
  { key: 'png', label: 'PNG images', extensions: ['png'], video: false },
  { key: 'gif', label: 'GIF animations', extensions: ['gif'], video: false },
  { key: 'webp', label: 'WebP / AVIF', extensions: ['webp', 'avif'], video: false },
  { key: 'tiff', label: 'BMP / TIFF', extensions: ['bmp', 'tif', 'tiff', 'ico'], video: false },
  { key: 'raw', label: 'RAW photos', extensions: ['dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2'], video: false },
  { key: 'mp4', label: 'MP4 / MOV videos', extensions: ['mp4', 'mov', 'm4v'], video: true },
  { key: 'mts', label: 'Camcorder videos (MTS)', extensions: ['mts', 'm2ts'], video: true },
  { key: 'avi', label: 'AVI / WMV / MKV videos', extensions: ['avi', 'wmv', 'mkv'], video: true },
  { key: 'mobile', label: '3GP / WebM / MPEG videos', extensions: ['3gp', 'webm', 'mpg', 'mpeg'], video: true },
]

/** Extensions (lower case, no dot) of the given FILE_TYPES group keys. */
const skippedExtensions = (keys) => {
  const want = new Set((Array.isArray(keys) ? keys : []).map((k) => String(k).toLowerCase()))
  return new Set(FILE_TYPES.filter((g) => want.has(g.key)).flatMap((g) => g.extensions))
}

const normFolder = (x) => String(x).toLowerCase().replace(/[\\/]+$/, '')

/** Skip options for scanning: { skipFolders: string[], skipTypes: string[], minBytes: number }. */
const normSkip = (options) => ({
  folders: (Array.isArray(options?.skipFolders) ? options.skipFolders : []).filter((x) => typeof x === 'string' && x).map(normFolder),
  exts: skippedExtensions(options?.skipTypes),
  minBytes: Math.max(0, Number(options?.minBytes) || 0),
})

const MIN_VALID_DATE = Date.UTC(1971, 0, 1)
const MAC_EPOCH = Date.UTC(1904, 0, 1)

const extOf = (p) => path.extname(p).slice(1).toLowerCase()
const keyOf = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
const idOf = (p) => crypto.createHash('sha1').update(keyOf(p)).digest('hex').slice(0, 16)
const isMedia = (p) => {
  const ext = extOf(p)
  return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)
}
const validDate = (ms) => Number.isFinite(ms) && ms > MIN_VALID_DATE && ms < Date.now() + 86_400_000

/** Run `fn` over `list` with at most `limit` concurrent promises. */
async function pool(list, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const item = list[i++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** Lower-cased folder paths whose contents are left out (e.g. where removed duplicates go). */
const isExcluded = (full, exclude) => {
  if (!exclude?.length) return false
  const p = full.toLowerCase()
  return exclude.some((x) => p === x || p.startsWith(x + path.sep))
}

/**
 * @param {string[]} exclude lower-cased folders left out (never the root itself)
 * @param {Set<string>} [skipExts] extensions left out (skipped file types)
 */
async function walk(dir, out, onFound, exclude, skipExts) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())) continue
    const full = path.join(dir, name)
    if (entry.isDirectory()) {
      if (!isExcluded(full, exclude)) await walk(full, out, onFound, exclude, skipExts)
    } else if (entry.isFile() && isMedia(name) && !skipExts?.has(extOf(name))) {
      out.set(keyOf(full), full)
      onFound()
    }
  }
}

async function readExif(file) {
  try {
    const d = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      ifd1: false,
      interop: false,
      icc: false,
      jfif: false,
      ...XMP_OPTIONS, // ratings & tags (XMP, IPTC keywords)
      ihdr: false,
      translateValues: false,
    })
    if (!d) return null
    const taken = d.DateTimeOriginal || d.CreateDate || d.ModifyDate
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
    return {
      date: taken instanceof Date ? taken.getTime() : NaN,
      meta: Object.keys(meta).length ? meta : undefined,
      marks: fromExifr(d),
    }
  } catch {
    return null
  }
}

const MAX_MOOV = 16 * 1024 * 1024
// ISO 6709 position as phones write it: "+42.3601-071.0589+012.345/" (Apple: com.apple.quicktime.
// location.ISO6709 in moov/meta; Android: moov/udta/©xyz). Searching the moov box finds either.
const ISO6709 = /([+-]\d{1,2}\.\d{2,})([+-]\d{1,3}\.\d{2,})/

/** Reads duration, creation time (`mvhd` box) and GPS position from an MP4/MOV file. */
async function readMp4(file) {
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
      } else if (boxSize === 0) {
        boxSize = size - pos
      }
      if (boxSize < headerLen) return null
      if (type === 'moov') {
        const moov = Buffer.alloc(Math.min(boxSize - headerLen, MAX_MOOV))
        await fh.read(moov, 0, moov.length, pos + headerLen)
        const out = {}
        let child = 0
        while (child + 8 <= moov.length) {
          const childSize = moov.readUInt32BE(child)
          if (moov.toString('latin1', child + 4, child + 8) === 'mvhd' && child + 40 <= moov.length) {
            const b = moov.subarray(child + 8, child + 40)
            let created, timescale, duration
            if (b[0] === 1) {
              created = Number(b.readBigUInt64BE(4))
              timescale = b.readUInt32BE(20)
              duration = Number(b.readBigUInt64BE(24))
            } else {
              created = b.readUInt32BE(4)
              timescale = b.readUInt32BE(12)
              duration = b.readUInt32BE(16)
            }
            const createdMs = created ? MAC_EPOCH + created * 1000 : NaN
            if (timescale) out.duration = duration / timescale
            if (validDate(createdMs)) out.created = createdMs
            break
          }
          if (childSize < 8) break
          child += childSize
        }
        const marks = fromMoov(moov)
        if (marks) out.marks = marks
        const gps = moov.toString('latin1').match(ISO6709)
        if (gps) {
          const lat = Number(gps[1])
          const lon = Number(gps[2])
          if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)) out.gps = { lat, lon }
        }
        return out
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

/** A rating / keywords found in the file. */
function applyMarks(item, marks) {
  if (marks?.rating) item.rating = marks.rating
  if (marks?.tags?.length) item.tags = marks.tags
}

async function buildItem(file, st) {
  const ext = extOf(file)
  const type = VIDEO_EXT.has(ext) ? 'video' : 'image'
  const mtime = Math.round(st.mtimeMs)
  const birth = Math.round(st.birthtimeMs) || mtime
  const item = {
    id: idOf(file),
    path: file,
    name: path.basename(file),
    dir: path.dirname(file),
    type,
    ext,
    size: st.size,
    mtime,
    added: birth,
    date: Math.min(mtime, birth),
    /** Capture date from the file itself (EXIF / video metadata), or null: not just a file date. */
    taken: null,
    /** Stars saved in the file (0 = none); Lumen's own ratings live in tags.json. */
    rating: 0,
  }
  if (type === 'image' && EXIF_EXT.has(ext)) {
    const exif = await readExif(file)
    if (exif) {
      if (validDate(exif.date)) item.date = item.taken = exif.date
      if (exif.meta) item.meta = exif.meta
      applyMarks(item, exif.marks)
    }
  } else if (type === 'video' && MP4_EXT.has(ext)) {
    const mp4 = await readMp4(file)
    if (mp4) {
      if (mp4.duration) item.duration = mp4.duration
      if (mp4.created) item.date = item.taken = mp4.created
      if (mp4.gps) item.meta = { lat: mp4.gps.lat, lon: mp4.gps.lon }
      applyMarks(item, mp4.marks)
    }
  }
  return item
}

/**
 * The media index. Scans library folders, extracts metadata (EXIF / MP4),
 * caches everything to disk and watches folders for changes.
 */
class Library extends EventEmitter {
  constructor(cacheFile) {
    super()
    this.cacheFile = cacheFile
    this.items = new Map() // key(path) -> item
    this.byId = new Map()
    this.list = []
    this.scanning = false
    this.found = 0
    this.rescanQueued = false
    this.watchers = []
    this.watchTimer = null
    this.exclude = []
    this.skip = normSkip(null)
  }

  async load() {
    try {
      const data = JSON.parse(await fsp.readFile(this.cacheFile, 'utf8'))
      if (data.version === 1 && Array.isArray(data.items)) {
        this.setItems(new Map(data.items.map((it) => [keyOf(it.path), it])))
      }
    } catch {}
  }

  async save() {
    try {
      await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true })
      const tmp = `${this.cacheFile}.tmp`
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, items: this.list }))
      await fsp.rename(tmp, this.cacheFile)
    } catch (err) {
      console.error('Failed to save library cache', err)
    }
  }

  setItems(map) {
    this.items = map
    this.list = [...map.values()]
    this.byId = new Map(this.list.map((it) => [it.id, it]))
  }

  get(id) {
    return this.byId.get(id)
  }

  status() {
    return { scanning: this.scanning, found: this.found }
  }

  /** Fills in metadata discovered later (e.g. a video's duration once it has been played). */
  patch(id, fields) {
    const item = this.byId.get(id)
    if (!item) return
    Object.assign(item, fields)
    clearTimeout(this.patchTimer)
    this.patchTimer = setTimeout(() => {
      this.emit('changed')
      this.save()
    }, 1000)
  }

  remove(ids) {
    const drop = new Set(ids)
    const next = new Map()
    for (const [key, it] of this.items) if (!drop.has(it.id)) next.set(key, it)
    this.setItems(next)
    this.emit('changed')
    this.save()
  }

  /**
   * @param {string[]} exclude folders to leave out
   * @param {{ skipFolders?: string[], skipTypes?: string[], minBytes?: number }} [options] the
   *   user's skip lists: folders (and their subfolders), FILE_TYPES group keys, files under a size
   */
  async scan(folders, exclude = this.exclude, options = this.scanOptions) {
    this.exclude = (exclude ?? []).map(normFolder)
    this.scanOptions = options ?? {}
    this.skip = normSkip(this.scanOptions)
    this.scanFolders = folders
    if (this.scanning) {
      this.rescanQueued = true
      return
    }
    const skip = this.skip
    const walkExclude = [...this.exclude, ...skip.folders]
    this.scanning = true
    this.found = 0
    let lastStatus = 0
    const emitStatus = (force) => {
      const now = Date.now()
      if (force || now - lastStatus > 200) {
        lastStatus = now
        this.emit('status', this.status())
      }
    }
    emitStatus(true)

    try {
      const files = new Map()
      for (const root of folders) {
        await walk(
          root,
          files,
          () => {
            this.found++
            emitStatus(false)
          },
          walkExclude,
          skip.exts,
        )
      }
      emitStatus(true)

      // First run: publish results progressively so the grid fills in as we go.
      const progressive = this.items.size === 0
      let lastPublish = Date.now()
      let changed = false
      const next = new Map()

      await pool([...files], 16, async ([key, file]) => {
        let st
        try {
          st = await fsp.stat(file)
        } catch {
          return
        }
        if (st.size < skip.minBytes) return // "Skip tiny files" (stickers, icons, thumbnails)
        const prev = this.items.get(key)
        // (items cached by Lumen < 1.8 lack `taken`: read their metadata again once)
        if (prev && prev.size === st.size && prev.mtime === Math.round(st.mtimeMs) && prev.taken !== undefined && prev.rating !== undefined) {
          next.set(key, prev)
          return
        }
        changed = true
        next.set(key, await buildItem(file, st))
        if (progressive && Date.now() - lastPublish > 1200) {
          lastPublish = Date.now()
          this.setItems(new Map(next))
          this.emit('changed')
        }
      })

      if (!changed && next.size !== this.items.size) changed = true
      if (!changed) {
        for (const key of this.items.keys()) {
          if (!next.has(key)) {
            changed = true
            break
          }
        }
      }
      if (changed || progressive) {
        this.setItems(next)
        this.emit('changed')
        await this.save()
      }
    } finally {
      this.scanning = false
      emitStatus(true)
      if (this.rescanQueued) {
        this.rescanQueued = false
        // the latest request's folders and options (one may have been added mid-scan)
        this.scan(this.scanFolders ?? folders, this.exclude, this.scanOptions)
      } else {
        this.emit('scanned')
      }
    }
  }

  /** Does this file differ (size or date) from its library entry? True for files not in the library. */
  async changedOnDisk(full) {
    const prev = this.items.get(keyOf(full))
    if (!prev) return true
    try {
      const st = await fsp.stat(full)
      return st.size !== prev.size || Math.round(st.mtimeMs) !== prev.mtime
    } catch {
      return true // gone
    }
  }

  /** Would walk() (from library folder `root`, lower-cased) pick up this media file? */
  wouldScan(full, root) {
    const segments = path.relative(root, full.toLowerCase()).split(path.sep)
    if (segments.some((s) => s.startsWith('.') || SKIP_DIRS.has(s))) return false
    const dir = path.dirname(full)
    // as in walk(): files directly in the library folder are never excluded
    return normFolder(dir) === root || !isExcluded(dir, [...this.exclude, ...this.skip.folders])
  }

  /**
   * Watches `folders` and calls `onChange` (debounced) when media may have changed. Also emits
   * 'file' (fullPath, 'rename' | 'change') for every media file event that a scan would include
   * (not a skipped type, not in an excluded or skipped folder); 'rename' = created, renamed or
   * deleted. Used by watch-alerts to check newly appeared files.
   */
  watch(folders, onChange) {
    for (const w of this.watchers) w.close()
    this.watchers = []
    const rescanSoon = () => {
      clearTimeout(this.watchTimer)
      this.watchTimer = setTimeout(onChange, 1500)
    }
    for (const folder of folders) {
      try {
        const root = normFolder(folder)
        const watcher = fs.watch(folder, { recursive: true }, (event, filename) => {
          if (filename && extOf(filename) && !isMedia(filename)) return
          if (filename && this.skip.exts.has(extOf(filename))) return // a skipped file type: nothing to rescan
          const full = filename ? path.join(folder, filename) : null
          if (full && isMedia(filename)) {
            if (this.wouldScan(full, root)) this.emit('file', full, event)
          }
          // Windows reports reading a file (previews, text, video frames, the viewer…) as a change
          // of the file and its folder, because its last-access time moves. Only a new size or date
          // is worth a rescan; files that come, go or are renamed arrive as 'rename'.
          if (event === 'change' && full) {
            if (!isMedia(filename) || !this.wouldScan(full, root)) return
            this.changedOnDisk(full).then((changed) => changed && rescanSoon())
            return
          }
          rescanSoon()
        })
        watcher.on('error', () => {})
        this.watchers.push(watcher)
      } catch {}
    }
  }
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm',
  '3gp': 'video/3gpp', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
}

module.exports = { Library, idOf, keyOf, extOf, isMedia, MIME, IMAGE_EXT, VIDEO_EXT, FILE_TYPES, skippedExtensions }
