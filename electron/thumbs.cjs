const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
const sharp = require('sharp')
const exifr = require('exifr')
const { WorkerPool, heifSize } = require('./workers.cjs')
const { renameRetry } = require('./safe-file.cjs')

// One libvips thread per image and many images in parallel scales far better for
// thumbnails than one image using every core. No cache, so files are never held open.
sharp.concurrency(1)
sharp.cache(false)

// analysis: what face detection sees — sharper than a thumbnail, never cached.
const SIZES = { thumb: 480, preview: 2560, analysis: 1024 }
const SHARP_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff'])
const ALPHA_EXT = new Set(['png', 'webp', 'gif', 'avif', 'tif', 'tiff'])
const CORES = os.availableParallelism?.() ?? os.cpus().length
const CPU_JOBS = Math.max(2, Math.min(16, CORES - 2))
const RETRY_FAILED_MS = 5 * 60_000
const SWEEP_AFTER_MS = 10_000
// temp files are "<name>.<pid>-<n>.tmp" (as safe-file.cjs names them): ours, while being written, carry this
const OWN_TEMP = `.${process.pid}-`

let tempCount = 0
/**
 * Writes a cached file whole or not at all: to a temp file of its own, then renamed into place, so
 * Pics crashing mid-write can't leave half a preview behind. Not flushed to disk (unlike Pics'
 * own data): it's only a cache, and flushing each of ~30,000 files would slow the first run down;
 * what a power cut might leave is caught by looksWhole() and made again.
 */
async function writeCacheFile(file, data) {
  const tmp = `${file}${OWN_TEMP}${(tempCount++).toString(36)}.tmp`
  try {
    await fsp.writeFile(tmp, data)
    await renameRetry(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** Cached files are JPEG or WebP (PNG let through too): anything else (empty, zeros) is a broken one. */
const looksWhole = (buf) =>
  buf.length > 4 && ((buf[0] === 0xff && buf[1] === 0xd8) || ['RIFF', '\x89PNG'].includes(buf.toString('latin1', 0, 4)))

/**
 * v1.0 cached thumbnails as `<id>_<version>_<kind>.jpg`; v1.1+ uses `.img` (JPEG or WebP).
 * Renaming keeps every preview a v1.0 user already generated instead of rebuilding them all.
 * Returns the directory listing after migration.
 */
function migrateLegacyCache(dir) {
  const names = fs.readdirSync(dir)
  return names.map((name) => {
    if (!/_(thumb|preview)\.jpg$/.test(name)) return name
    const next = name.slice(0, -4) + '.img'
    try {
      fs.renameSync(path.join(dir, name), path.join(dir, next))
      return next
    } catch {
      return name
    }
  })
}

/** The long side in pixels of a photo libvips can't open (HEIC, RAW, BMP…), from its header. */
async function longSide(item) {
  try {
    // a HEIC's own header knows its size (EXIF may not have it)
    if (item.ext === 'heic' || item.ext === 'heif') {
      const size = await heifSize(item.path)
      if (size) return Math.max(size.width, size.height)
    }
    if (item.ext === 'bmp') {
      const fh = await fsp.open(item.path, 'r')
      const b = Buffer.alloc(26)
      await fh.read(b, 0, 26, 0)
      await fh.close()
      return Math.max(b.readInt32LE(18), Math.abs(b.readInt32LE(22)))
    }
    const d = await exifr.parse(item.path, { tiff: true, exif: true, gps: false, xmp: false, icc: false, iptc: false, ifd1: false })
    const w = d?.ExifImageWidth ?? d?.ImageWidth
    const h = d?.ExifImageHeight ?? d?.ImageHeight
    return w && h ? Math.max(w, h) : 0
  } catch {
    return 0
  }
}

/**
 * A bounded pool with two priorities. "high" = thumbnails on screen right now (LIFO, so the
 * latest scroll position wins); "low" = background pre-generation (FIFO, newest photos first),
 * which never takes every slot so on-screen requests can always start immediately.
 */
class Lane {
  constructor(size, backgroundSize) {
    this.size = size
    this.backgroundSize = backgroundSize
    this.active = 0
    this.activeBackground = 0
    this.high = []
    this.low = []
    this.lowIndex = 0
  }

  push(job) {
    ;(job.priority === 'high' ? this.high : this.low).push(job)
    this.pump()
  }

  promote(job) {
    if (job.state !== 'queued' || job.priority === 'high') return
    job.priority = 'high'
    this.high.push(job)
    this.pump()
  }

  next() {
    while (this.high.length) {
      const job = this.high.pop()
      if (job.state === 'queued') return job
    }
    if (this.activeBackground >= this.backgroundSize) return null
    while (this.lowIndex < this.low.length) {
      const job = this.low[this.lowIndex++]
      if (job.state === 'queued' && job.priority === 'low') return job
    }
    this.low = []
    this.lowIndex = 0
    return null
  }

  pump() {
    while (this.active < this.size) {
      const job = this.next()
      if (!job) return
      const background = job.priority === 'low'
      job.state = 'running'
      this.active++
      if (background) this.activeBackground++
      job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          job.state = 'done'
          this.active--
          if (background) this.activeBackground--
          this.pump()
        })
    }
  }
}

/**
 * Generates and caches thumbnails (480px) and previews (2560px, for formats Chromium can't show).
 *  - photos:  sharp/libvips on the libuv thread pool (SIMD, JPEG shrink-on-load, all cores)
 *  - videos:  GPU hardware decode in a hidden worker window
 *  - others:  OS thumbnail provider (HEIC, RAW, BMP…) in worker windows
 * Nothing here blocks the main process.
 */
class Thumbnails extends EventEmitter {
  constructor(dir) {
    super()
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
    // (temp files are half-written previews: never cached ones)
    this.cached = new Set(migrateLegacyCache(dir).filter((name) => !name.endsWith('.tmp')))
    this.jobs = new Map()
    this.failed = new Map() // name -> time of failure
    this.cpu = new Lane(CPU_JOBS, Math.max(1, CPU_JOBS - 2))
    // Few background decodes: a saturated GPU process stalls Chromium's UI thread natively.
    this.gpu = new Lane(8, 2)
    // Windows' HEIC/RAW decoders scale to ~4 processes (≈9x faster than 1); more just contend.
    this.shell = new Lane(4, 3)
    this.videoWorkers = new WorkerPool(2)
    this.shellWorkers = new WorkerPool(4)
    this.frameWorkers = null // video fingerprints (duplicates): its own offscreen worker, made on first use
    this.background = { pending: 0, total: 0 }
    this.progressTimer = null
    // Empty previews (older versions wrote them in place, so a crash could leave one) and temp files
    // left by a crash are cleared out a little after start-up: checking ~30,000 file sizes then
    // would hold it up.
    this.sweepTimer = setTimeout(() => this.sweep().catch(() => {}), SWEEP_AFTER_MS)
    this.sweepTimer.unref?.()
  }

  /** Forgets and deletes empty cached files and other runs' leftover temp files. */
  async sweep() {
    for (const name of await fsp.readdir(this.dir).catch(() => [])) {
      if (this.disposed) return
      const full = path.join(this.dir, name)
      if (name.endsWith('.tmp')) {
        if (!name.includes(OWN_TEMP)) await fsp.rm(full, { force: true }).catch(() => {})
        continue
      }
      if (!this.cached.has(name) || this.jobs.has(name)) continue
      const st = await fsp.stat(full).catch(() => null)
      if (st?.size !== 0 || this.jobs.has(name)) continue
      this.cached.delete(name)
      await fsp.rm(full, { force: true }).catch(() => {})
    }
  }

  /** The cached file's bytes, or null (not cached, or broken / unreadable: then it's made again). */
  async readCached(name) {
    if (!this.cached.has(name)) return null
    const full = path.join(this.dir, name)
    try {
      const buf = await fsp.readFile(full)
      if (looksWhole(buf)) return buf
      await fsp.rm(full, { force: true }).catch(() => {}) // empty or cut short by a crash
    } catch {}
    this.cached.delete(name)
    return null
  }

  name(item, kind) {
    return `${item.id}_${item.mtime.toString(36)}_${kind}.img`
  }

  file(item, kind) {
    return path.join(this.dir, this.name(item, kind))
  }

  cachedPath(item) {
    const name = this.name(item, 'thumb')
    return this.cached.has(name) ? path.join(this.dir, name) : null
  }

  isFailed(name) {
    const at = this.failed.get(name)
    if (at === undefined) return false
    if (Date.now() - at < RETRY_FAILED_MS) return true
    this.failed.delete(name)
    return false
  }

  /** Thumbnail bytes (JPEG or WebP) or null. Generates on demand at high priority. */
  async get(item, kind = 'thumb') {
    const name = this.name(item, kind)
    const cached = await this.readCached(name)
    if (cached) return cached
    if (this.isFailed(name)) return null
    return this.schedule(item, kind, 'high')
  }

  /** Thumbnail bytes for background analysis: the cached copy, else generated at background priority. */
  async ensure(item) {
    const name = this.name(item, 'thumb')
    const cached = await this.readCached(name)
    if (cached) return cached
    if (this.isFailed(name)) return null
    return this.schedule(item, 'thumb', 'low')
  }

  /**
   * The full-size picture for editing: the file itself when libvips can read it, else a full-size
   * render from Windows' own decoder (HEIC, RAW…). Resolves to a path or a JPEG buffer.
   */
  async source(item) {
    if (SHARP_EXT.has(item.ext)) return item.path
    // Windows enlarges to whatever size is asked for, so ask for the picture's own size.
    const size = Math.min(8192, (await longSide(item)) || 4096)
    const res = await this.shellWorkers.run({ type: 'shell', path: item.path, size, quality: 95 }, 60_000)
    return res?.data ? Buffer.from(res.data) : null
  }

  /** A 1024px JPEG for face analysis: background priority, not cached. */
  render(item) {
    return this.schedule(item, 'analysis', 'low')
  }

  laneFor(item) {
    if (item.type === 'video') return this.gpu
    return SHARP_EXT.has(item.ext) ? this.cpu : this.shell
  }

  schedule(item, kind, priority) {
    if (this.disposed) return Promise.resolve(null)
    const name = this.name(item, kind)
    const existing = this.jobs.get(name)
    if (existing) {
      if (priority === 'high') existing.lane.promote(existing)
      return existing.promise
    }
    const job = { name, item, kind, priority, state: 'queued', lane: this.laneFor(item) }
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
    })
    job.run = () => this.generate(job)
    this.jobs.set(name, job)
    // Progress reporting covers thumbnail pre-generation only.
    const tracked = priority === 'low' && kind === 'thumb'
    if (tracked) {
      this.background.pending++
      this.background.total++
    }
    job.promise
      .catch(() => null)
      .finally(() => {
        this.jobs.delete(name)
        if (tracked) {
          this.background.pending--
          this.emitProgress()
        }
      })
    job.lane.push(job)
    return job.promise
  }

  async generate({ item, kind, name }) {
    if (this.disposed) return null
    const size = SIZES[kind]
    let data = null
    if (item.type === 'video') {
      const res = await this.videoWorkers.run({ type: 'video', url: pathToFileURL(item.path).href, size })
      if (res?.duration && !item.duration) this.emit('duration', item.id, res.duration)
      data = res?.data
      if (!data) data = (await this.shellWorkers.run({ type: 'shell', path: item.path, size, video: true }))?.data
    } else if (SHARP_EXT.has(item.ext)) {
      data = await this.sharpThumb(item, size, kind !== 'analysis').catch(() => null)
      if (!data) data = (await this.shellWorkers.run({ type: 'shell', path: item.path, size }))?.data
    } else {
      data = (await this.shellWorkers.run({ type: 'shell', path: item.path, size }))?.data
    }
    if (!data || !data.length) {
      this.failed.set(name, Date.now())
      return null
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (kind === 'analysis') return buf
    try {
      // whole or not at all: a crash mid-write must not leave a broken preview behind for good
      await writeCacheFile(path.join(this.dir, name), buf)
      this.cached.add(name)
    } catch {}
    return buf
  }

  async sharpThumb(item, size, keepAlpha = true) {
    const pipeline = sharp(item.path, { failOn: 'none' })
      .rotate() // honour EXIF orientation
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    if (keepAlpha && ALPHA_EXT.has(item.ext)) {
      const meta = await sharp(item.path, { failOn: 'none' }).metadata()
      if (meta.hasAlpha) return pipeline.webp({ quality: 82, alphaQuality: 90, effort: 2 }).toBuffer()
    }
    return pipeline.jpeg({ quality: 80 }).toBuffer()
  }

  /**
   * Frame fingerprints of a video for duplicate detection (see worker.cjs / video-frames.cjs):
   * { duration, width, height, summary, dense, stats }; null when the video can't be decoded;
   * undefined when there was no answer (cancelled, timed out, worker crashed, quitting).
   * Runs in its own worker, so a long video never holds up thumbnails; that worker renders
   * offscreen, so it may also read frames by playing. `gentle`: prefer playing, which keeps the
   * app's windows smoother than seeking (for while the user is looking). `signal` cancels; the
   * timeout counts from the last progress report.
   */
  async videoFrames(item, { signal, onProgress, gentle = false } = {}) {
    if (this.disposed) return undefined
    this.frameWorkers ??= new WorkerPool(1, { offscreen: true })
    const job = { type: 'frames', url: pathToFileURL(item.path).href, play: true, gentle }
    const res = await this.frameWorkers.run(job, 60_000, { signal, onProgress })
    if (!res) return undefined
    const data = res.data ?? null
    if (data?.duration && !item.duration) this.emit('duration', item.id, data.duration)
    return data
  }

  warmUp(items) {
    if (items.some((it) => it.type === 'video')) this.videoWorkers.warmUp()
  }

  /** Queue thumbnails for everything not cached yet, newest first, at background priority. */
  prefetch(items) {
    const todo = items
      .filter((it) => {
        const name = this.name(it, 'thumb')
        return !this.cached.has(name) && !this.jobs.has(name) && !this.isFailed(name)
      })
      .sort((a, b) => b.date - a.date)
    for (const it of todo) this.schedule(it, 'thumb', 'low')
    this.emitProgress()
  }

  emitProgress() {
    if (this.progressTimer) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      const { pending, total } = this.background
      this.emit('progress', { pending, total })
      if (pending === 0) this.background.total = 0
    }, 250)
  }

  /** Deletes cached files that no longer belong to any library item (or an older version of it). */
  async prune(items) {
    const keep = new Set(items.map((it) => `${it.id}_${it.mtime.toString(36)}_`))
    for (const name of await fsp.readdir(this.dir).catch(() => [])) {
      const prefix = name.slice(0, name.lastIndexOf('_') + 1)
      if (name.endsWith('.img') && keep.has(prefix)) continue
      if (this.jobs.has(name)) continue
      if (name.endsWith('.tmp') && name.includes(OWN_TEMP)) continue // being written right now
      this.cached.delete(name)
      await fsp.rm(path.join(this.dir, name), { force: true }).catch(() => {})
    }
  }

  async size() {
    let bytes = 0
    let files = 0
    for (const name of await fsp.readdir(this.dir).catch(() => [])) {
      const st = await fsp.stat(path.join(this.dir, name)).catch(() => null)
      if (st) {
        bytes += st.size
        files++
      }
    }
    return { bytes, files }
  }

  async clear() {
    for (const name of await fsp.readdir(this.dir).catch(() => [])) {
      await fsp.rm(path.join(this.dir, name), { force: true }).catch(() => {})
    }
    this.cached.clear()
    this.failed.clear()
  }

  /** The app is quitting: drop queued work and close the worker windows for good. */
  dispose() {
    this.disposed = true
    clearTimeout(this.sweepTimer)
    for (const lane of [this.cpu, this.gpu, this.shell]) {
      lane.high = []
      lane.low = []
      lane.lowIndex = 0
    }
    this.videoWorkers.destroy()
    this.shellWorkers.destroy()
    this.frameWorkers?.destroy()
  }
}

module.exports = { Thumbnails, CPU_JOBS }
