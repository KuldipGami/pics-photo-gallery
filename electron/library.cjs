const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const exifr = require('exifr')
const { EXIFR_OPTIONS: XMP_OPTIONS, fromExifr, fromMoov } = require('./xmp.cjs')
const { writeAtomic, serial, readJson, keepAside } = require('./safe-file.cjs')

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
 * think of them (from DupeLens' FileTypes). Every extension Pics reads is in exactly one group.
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

/** Lower-cased, without a trailing separator; a drive root keeps its own ("c:\": "c:" alone means the current folder on C). */
const normFolder = (x) => {
  const s = String(x).toLowerCase().replace(/[\\/]+$/, '')
  return /^[a-z]:$/.test(s) ? s + path.sep : s
}

/** Is lower-cased path `p` the folder `dir` (normFolder) or inside it? */
const isUnder = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)

/** Skip options for scanning: { skipFolders: string[], skipTypes: string[], minBytes: number }. */
const normSkip = (options) => ({
  folders: (Array.isArray(options?.skipFolders) ? options.skipFolders : []).filter((x) => typeof x === 'string' && x).map(normFolder),
  exts: skippedExtensions(options?.skipTypes),
  minBytes: Math.max(0, Number(options?.minBytes) || 0),
})

const RETRY_WATCH_MS = 30_000 // a library folder that isn't there: look again this often
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

/**
 * Does a watcher event's name end in a real file extension ("notes.txt", "IMG_1.jpg.lumen.old")?
 * Folder names often have dots too ("2019.05.12 Goa", "Trip.2019"): an "extension" with spaces,
 * only digits or more than 6 characters isn't one.
 */
const hasFileExtension = (name) => /^\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,6}$/i.test(path.extname(name))

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
  return exclude.some((x) => isUnder(p, x))
}

/**
 * Throws when `dir` itself can't be read (the caller decides what that means for a library folder).
 * @param {string[]} exclude lower-cased folders left out (never the root itself)
 * @param {Set<string>} [skipExts] extensions left out (skipped file types)
 * @param {string[]} [unread] collects subfolders that are there but couldn't be read
 */
async function walk(dir, out, onFound, exclude, skipExts, unread, top = true) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (top) throw err
    // A subfolder that's gone was deleted or moved away. Any other error (no permission, a network
    // hiccup, a disk error) says nothing about what's in it: its items are kept as they were.
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') unread?.push(dir)
    return
  }
  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())) continue
    const full = path.join(dir, name)
    if (entry.isDirectory()) {
      if (!isExcluded(full, exclude)) await walk(full, out, onFound, exclude, skipExts, unread, false)
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
    // the first real date: a zeroed one ("0000:00:00 00:00:00") comes back from exifr as 1899
    const taken = [d.DateTimeOriginal, d.CreateDate, d.ModifyDate].find((x) => x instanceof Date && validDate(x.getTime()))
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
      date: taken ? taken.getTime() : NaN,
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

/** Child boxes of `buf` between `start` and `end`: [{ at (the box), type, start (of the body), end }]. */
function childBoxes(buf, start = 0, end = buf.length) {
  const out = []
  for (let pos = start; pos + 8 <= end; ) {
    let size = buf.readUInt32BE(pos)
    let header = 8
    if (size === 1 && pos + 16 <= end) {
      size = Number(buf.readBigUInt64BE(pos + 8))
      header = 16
    } else if (size === 0) size = end - pos
    if (size < header || pos + size > end) break
    out.push({ at: pos, type: buf.toString('latin1', pos + 4, pos + 8), start: pos + header, end: pos + size })
    pos += size
  }
  return out
}

// "2023-03-10T18:00:05+0530": with an offset, or none. ("…Z" is UTC, no better than `mvhd`.)
const APPLE_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[+-]\d{2}:?\d{2})?$/

/**
 * The time of recording as the clock where it was recorded showed it, from iPhones' (and other
 * Apple-style recorders') moov/meta key com.apple.quicktime.creationdate, e.g.
 * "2023-03-10T18:00:05+0530", taken as local time the way photos' EXIF dates are, so a video sits
 * among the photos taken with it on a trip abroad (`mvhd` is UTC). NaN when there is none.
 */
function appleCreationDate(moov) {
  const meta = childBoxes(moov).find((b) => b.type === 'meta')
  if (!meta) return NaN
  // QuickTime's meta box has no version/flags (the ISO one does)
  let kids = childBoxes(moov, meta.start, meta.end)
  if (!kids.some((b) => b.type === 'keys')) kids = childBoxes(moov, meta.start + 4, meta.end)
  const keys = kids.find((b) => b.type === 'keys')
  const ilst = kids.find((b) => b.type === 'ilst')
  if (!keys || !ilst || keys.start + 8 > keys.end) return NaN
  // keys: version/flags, count, then [size, namespace, name] each; ilst refers to them from 1
  let index = 0
  const count = moov.readUInt32BE(keys.start + 4)
  for (let i = 1, p = keys.start + 8; i <= count && p + 8 <= keys.end; i++) {
    const size = moov.readUInt32BE(p)
    if (size < 8 || p + size > keys.end) break
    if (moov.toString('latin1', p + 8, p + size) === 'com.apple.quicktime.creationdate') {
      index = i
      break
    }
    p += size
  }
  if (!index) return NaN
  for (const entry of childBoxes(moov, ilst.start, ilst.end)) {
    if (moov.readUInt32BE(entry.at + 4) !== index) continue
    const data = childBoxes(moov, entry.start, entry.end).find((b) => b.type === 'data')
    if (!data || data.start + 8 >= data.end) return NaN
    // data: type, locale, then the text
    const m = moov.toString('utf8', data.start + 8, data.end).replace(/\0+$/, '').trim().match(APPLE_DATE)
    if (!m) return NaN
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
    const date = new Date(y, mo - 1, d, h, mi, s)
    // the calendar must agree (no 31 February)
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return NaN
    return date.getTime()
  }
  return NaN
}

/**
 * Reads duration, creation time (`mvhd` box, UTC; `local`: the recorder's own clock, when it
 * wrote one) and GPS position from an MP4/MOV file.
 */
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
        let local = NaN
        try {
          local = appleCreationDate(moov)
        } catch {} // a damaged meta box: the rest still counts
        if (validDate(local)) out.local = local
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
    /** Stars saved in the file (0 = none); Pics' own ratings live in tags.json. */
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
    /** true: `taken` is the recorder's own clock time (as photos' EXIF); false: from `mvhd` (UTC) or none. */
    item.localTime = false
    if (mp4) {
      if (mp4.duration) item.duration = mp4.duration
      if (mp4.local) {
        item.date = item.taken = mp4.local
        item.localTime = true
      } else if (mp4.created) item.date = item.taken = mp4.created
      if (mp4.gps) item.meta = { lat: mp4.gps.lat, lon: mp4.gps.lon }
      applyMarks(item, mp4.marks)
    }
  }
  return item
}

/**
 * A video cached before Pics read the recorder's own clock: only its date is read again (id,
 * path, size and modified time stay, so its preview and analysis stay valid).
 */
async function withLocalTime(prev) {
  const mp4 = await readMp4(prev.path)
  if (!mp4?.local) return { ...prev, localTime: false }
  return { ...prev, date: mp4.local, taken: mp4.local, localTime: true }
}

/** A video cached before `localTime` was read. */
const needsLocalTime = (it) => it.type === 'video' && MP4_EXT.has(it.ext) && it.localTime === undefined

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
    this.watchers = new Map() // library folder -> fs.watch watcher
    this.watchFolders = []
    this.watchTimer = null
    this.retryTimer = null
    this.watchRound = 0
    this.exclude = []
    this.skip = normSkip(null)
    /** Library folders the last scan couldn't read (drive not connected…): their items were kept as they were. */
    this.unreachable = []
    /**
     * How load() went: 'ok' | 'missing' (first run) | 'corrupt' (damaged; kept aside as
     * library.json.damaged-…, starting empty) | 'error' (there but unreadable: never saved over).
     */
    this.loadState = 'missing'
    // one save at a time, each to a temp file of its own, so two saves can't mix
    this.saveRun = serial(() => writeAtomic(this.cacheFile, JSON.stringify({ version: 1, items: this.list })))
  }

  async load() {
    const res = await readJson(this.cacheFile)
    if (res.data) {
      const data = res.data
      if (data?.version === 1 && Array.isArray(data.items)) {
        const items = data.items.filter((it) => it && typeof it.path === 'string' && typeof it.id === 'string')
        this.setItems(new Map(items.map((it) => [keyOf(it.path), it])))
        this.loadState = 'ok'
      } else {
        // not a library Pics knows (a newer version's?): kept aside rather than overwritten
        const keptAs = keepAside(this.cacheFile)
        console.error('Library cache not understood; kept as', keptAs)
        this.loadState = 'corrupt'
      }
    } else if (res.missing) {
      this.loadState = 'missing'
    } else if (res.corrupt) {
      console.error('Library cache damaged; kept as', res.keptAs)
      this.loadState = 'corrupt'
    } else {
      console.error('Failed to read library cache', res.error)
      this.loadState = 'error'
    }
  }

  async save() {
    // library.json is there but couldn't be read: writing now would replace it with less (the items
    // of a drive that isn't connected, say), so this session leaves it as it is
    if (this.loadState === 'error') return
    try {
      await this.saveRun()
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

  /** `unreachable`: library folders the last scan couldn't read (their items were kept as they were). */
  status() {
    return { scanning: this.scanning, found: this.found, unreachable: [...this.unreachable] }
  }

  /** Is this path in a library folder the last scan couldn't read? Its items there were only kept, not checked. */
  isUnreachable(p) {
    const key = String(p).toLowerCase()
    return this.unreachable.some((root) => isUnder(key, normFolder(root)))
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
      // library.json couldn't be read at start-up (another program holding it?): one more try
      // before building the library from nothing
      let reloaded = false
      if (this.loadState === 'error' && this.items.size === 0) {
        await this.load()
        reloaded = this.items.size > 0
      }

      const files = new Map()
      const unreachable = [] // library folders that couldn't be read at all
      const kept = [] // [folder, its library folder] (normFolder): earlier items in these stay as they were
      const onFound = () => {
        this.found++
        emitStatus(false)
      }
      for (const root of folders) {
        const unread = []
        try {
          await walk(root, files, onFound, walkExclude, skip.exts, unread)
        } catch {
          // A drive that isn't connected, a network share not there yet (Pics starts with
          // Windows), a folder renamed in Explorer, no permission…: that says nothing about what's
          // in it, so it isn't taken as empty (which would forget its people, tags, text…)
          unreachable.push(root)
          continue
        }
        for (const dir of unread) kept.push([normFolder(dir), normFolder(root)])
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
        } catch (err) {
          // gone since it was listed: dropped; can't be read right now (locked…): kept as it was
          const prev = this.items.get(key)
          if (prev && err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') next.set(key, prev)
          return
        }
        if (st.size < skip.minBytes) return // "Skip tiny files" (stickers, icons, thumbnails)
        const prev = this.items.get(key)
        // (items cached by Pics < 1.8 lack `taken`: read their metadata again once)
        if (prev && prev.size === st.size && prev.mtime === Math.round(st.mtimeMs) && prev.taken !== undefined && prev.rating !== undefined) {
          if (needsLocalTime(prev)) {
            changed = true
            next.set(key, await withLocalTime(prev))
          } else next.set(key, prev)
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

      // A library folder that went away during the scan (a drive unplugged) wasn't emptied either.
      for (const root of folders) {
        if (unreachable.includes(root)) continue
        const st = await fsp.stat(root).catch(() => null)
        if (st?.isDirectory()) continue
        unreachable.push(root)
        const dir = normFolder(root)
        for (const key of [...next.keys()]) if (isUnder(key, dir)) next.delete(key)
      }
      for (const root of unreachable) kept.push([normFolder(root), normFolder(root)])
      // Their earlier items stay, the very same ones (so nothing that follows the library sees a
      // change), unless the skip lists now leave them out. Removing a folder from the library
      // still drops its items: it isn't in `folders` any more.
      if (kept.length) {
        for (const [key, prev] of this.items) {
          if (next.has(key)) continue
          const hit = kept.find(([dir]) => isUnder(key, dir))
          if (hit && this.keeps(prev, hit[1])) next.set(key, prev)
        }
      }
      this.unreachable = unreachable
      if (unreachable.length) console.warn('[library] not readable, items kept:', unreachable.join(', '))

      if (!changed && next.size !== this.items.size) changed = true
      if (!changed) {
        for (const key of this.items.keys()) {
          if (!next.has(key)) {
            changed = true
            break
          }
        }
      }
      if (changed || progressive || reloaded) {
        this.setItems(next)
        this.emit('changed')
        await this.save()
      }
    } finally {
      this.scanning = false
      emitStatus(true)
      this.retryWatchSoon() // a library folder that couldn't be read is looked at again in a while
      if (this.rescanQueued) {
        this.rescanQueued = false
        // the latest request's folders and options (one may have been added mid-scan)
        this.scan(this.scanFolders ?? folders, this.exclude, this.scanOptions)
      } else {
        this.emit('scanned')
      }
    }
  }

  /**
   * Does this file differ (size or date) from its library entry? For a file not in the library:
   * would a scan take it (not one "Skip tiny files" leaves out)?
   */
  async changedOnDisk(full) {
    const prev = this.items.get(keyOf(full))
    try {
      const st = await fsp.stat(full)
      if (!prev) return st.isFile() && st.size >= this.skip.minBytes
      return st.size !== prev.size || Math.round(st.mtimeMs) !== prev.mtime
    } catch {
      return !!prev // gone
    }
  }

  /** Would walk() (from library folder `root`, normFolder) pick up this media file? */
  wouldScan(full, root) {
    const segments = path.relative(root, full.toLowerCase()).split(path.sep)
    if (segments.some((s) => s.startsWith('.') || SKIP_DIRS.has(s))) return false
    const dir = path.dirname(full)
    // as in walk(): files directly in the library folder are never excluded
    return normFolder(dir) === root || !isExcluded(dir, [...this.exclude, ...this.skip.folders])
  }

  /** Would a scan from library folder `root` (normFolder) still take this earlier item? (Skip lists, size.) */
  keeps(item, root) {
    return this.wouldScan(item.path, root) && !this.skip.exts.has(extOf(item.path)) && !(item.size < this.skip.minBytes)
  }

  /** Lower-cased folders that hold library items, and every folder above them. */
  knownFolders() {
    if (this.folderIndex?.list !== this.list) {
      const set = new Set()
      for (const it of this.list) {
        for (let dir = keyOf(path.dirname(it.path)); !set.has(dir); dir = path.dirname(dir)) {
          set.add(dir)
          if (path.dirname(dir) === dir) break
        }
      }
      this.folderIndex = { list: this.list, set }
    }
    return this.folderIndex.set
  }

  /**
   * Watches `folders` and calls `onChange` (debounced) when media may have changed. Also emits
   * 'file' (fullPath, 'rename' | 'change') for every media file event that a scan would include
   * (not a skipped type, not in an excluded or skipped folder); 'rename' = created, renamed or
   * deleted. Used by watch-alerts to check newly appeared files.
   * A folder that can't be watched (its drive isn't connected) or whose watcher fails (unplugged)
   * is looked at every 30 s; once it's back it is watched again and rescanned.
   */
  watch(folders, onChange) {
    for (const w of this.watchers.values()) w.close()
    this.watchers = new Map()
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.watchRound++
    this.watchFolders = [...folders]
    this.onWatchChange = onChange
    for (const folder of this.watchFolders) this.watchFolder(folder)
    this.retryWatchSoon()
  }

  rescanSoon() {
    clearTimeout(this.watchTimer)
    this.watchTimer = setTimeout(() => this.onWatchChange?.(), 1500)
  }

  /** Starts watching one library folder. False when it can't be watched right now. */
  watchFolder(folder) {
    const root = normFolder(folder)
    let watcher
    try {
      watcher = fs.watch(folder, { recursive: true }, (event, filename) => this.onFolderEvent(folder, root, event, filename))
    } catch {
      return false
    }
    watcher.on('error', () => {
      // the drive was unplugged, the network share went away…: watched again once it's back
      watcher.close()
      if (this.watchers.get(folder) !== watcher) return
      this.watchers.delete(folder)
      this.rescanSoon()
      this.retryWatchSoon()
    })
    this.watchers.set(folder, watcher)
    return true
  }

  onFolderEvent(folder, root, event, filename) {
    if (!filename) return this.rescanSoon()
    const full = path.join(folder, filename)
    if (isMedia(filename)) {
      if (this.skip.exts.has(extOf(filename))) return // a skipped file type: nothing to rescan
      const scanned = this.wouldScan(full, root)
      if (scanned) this.emit('file', full, event)
      // Windows reports reading a file (previews, text, video frames, the viewer…) as a change
      // of the file and its folder, because its last-access time moves. Only a new size or date
      // is worth a rescan; files that come, go or are renamed arrive as 'rename'.
      if (event === 'change') {
        if (scanned) this.changedOnDisk(full).then((changed) => changed && this.rescanSoon())
        return
      }
      return this.rescanSoon()
    }
    // Not a photo or video: a folder ("2019.05.12 Goa" too) or another kind of file. A folder's
    // 'change' is its last-access time; one that comes, goes or is renamed may hold many photos.
    if (event === 'change') return
    this.isFolderEvent(full, filename).then((yes) => yes && this.rescanSoon())
  }

  /** A name that isn't a photo or video came, went or was renamed: is it (or was it) a folder? */
  async isFolderEvent(full, filename) {
    try {
      return (await fsp.stat(full)).isDirectory() // else another kind of file: nothing to do
    } catch {
      // Gone: a folder the library had photos in (deleted, or moved / renamed away). A name
      // without a file extension might have been any folder, so it's rescanned anyway.
      return !hasFileExtension(filename) || this.knownFolders().has(keyOf(full))
    }
  }

  isUnreachableRoot(folder) {
    const dir = normFolder(folder)
    return this.unreachable.some((root) => normFolder(root) === dir)
  }

  /** While a library folder can't be watched or read, looks every 30 s whether it's back. */
  retryWatchSoon() {
    if (this.retryTimer) return
    if (!this.watchFolders.some((f) => !this.watchers.has(f) || this.isUnreachableRoot(f))) return
    const round = this.watchRound
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (round === this.watchRound) this.retryWatch(round).catch(() => {})
    }, RETRY_WATCH_MS)
    this.retryTimer.unref?.()
  }

  async retryWatch(round) {
    let back = false
    for (const folder of this.watchFolders) {
      const unwatched = !this.watchers.has(folder)
      if (!unwatched && !this.isUnreachableRoot(folder)) continue
      try {
        await fsp.readdir(folder)
      } catch {
        continue // still not there
      }
      if (round !== this.watchRound) return // watch() was called again meanwhile
      if (unwatched && !this.watchers.has(folder) && !this.watchFolder(folder)) continue
      back = true
    }
    // Read what's there now (the items kept while it was away are brought up to date); the scan
    // looks at what's still missing when it ends.
    if (back) this.rescanSoon()
    else this.retryWatchSoon()
  }
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm',
  '3gp': 'video/3gpp', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
}

module.exports = { Library, idOf, keyOf, extOf, isMedia, MIME, IMAGE_EXT, VIDEO_EXT, FILE_TYPES, skippedExtensions }
