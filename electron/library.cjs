const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const exifr = require('exifr')

const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico',
  'heic', 'heif', 'tif', 'tiff', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2',
])
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', '3gp', 'mts', 'm2ts', 'mpg', 'mpeg'])
const EXIF_EXT = new Set(['jpg', 'jpeg', 'jfif', 'heic', 'heif', 'tif', 'tiff', 'dng', 'avif', 'webp', 'png'])
const MP4_EXT = new Set(['mp4', 'm4v', 'mov', '3gp'])
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', 'appdata', '__macosx'])

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

async function walk(dir, out, onFound) {
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
      await walk(full, out, onFound)
    } else if (entry.isFile() && isMedia(name)) {
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
      xmp: false,
      icc: false,
      iptc: false,
      jfif: false,
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
  }
  if (type === 'image' && EXIF_EXT.has(ext)) {
    const exif = await readExif(file)
    if (exif) {
      if (validDate(exif.date)) item.date = exif.date
      if (exif.meta) item.meta = exif.meta
    }
  } else if (type === 'video' && MP4_EXT.has(ext)) {
    const mp4 = await readMp4(file)
    if (mp4) {
      if (mp4.duration) item.duration = mp4.duration
      if (mp4.created) item.date = mp4.created
      if (mp4.gps) item.meta = { lat: mp4.gps.lat, lon: mp4.gps.lon }
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

  async scan(folders) {
    if (this.scanning) {
      this.rescanQueued = true
      return
    }
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
        await walk(root, files, () => {
          this.found++
          emitStatus(false)
        })
      }
      emitStatus(true)

      // First run: publish results progressively so the grid fills in as we go.
      const progressive = this.items.size === 0
      let lastPublish = Date.now()
      let changed = files.size !== this.items.size
      const next = new Map()

      await pool([...files], 16, async ([key, file]) => {
        let st
        try {
          st = await fsp.stat(file)
        } catch {
          return
        }
        const prev = this.items.get(key)
        if (prev && prev.size === st.size && prev.mtime === Math.round(st.mtimeMs)) {
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
        this.scan(folders)
      } else {
        this.emit('scanned')
      }
    }
  }

  watch(folders, onChange) {
    for (const w of this.watchers) w.close()
    this.watchers = []
    for (const folder of folders) {
      try {
        const watcher = fs.watch(folder, { recursive: true }, (_event, filename) => {
          if (filename && extOf(filename) && !isMedia(filename)) return
          clearTimeout(this.watchTimer)
          this.watchTimer = setTimeout(onChange, 1500)
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

module.exports = { Library, idOf, keyOf, extOf, MIME }
