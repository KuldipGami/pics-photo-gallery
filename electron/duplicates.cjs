const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { Worker } = require('node:worker_threads')
const sharp = require('sharp')
const exifr = require('exifr')
const sig = require('./signature.cjs')

// Duplicate detection, ported from DupeLens:
//  - exact copies: same size + same content hash
//  - look-alikes: perceptual fingerprints (signature.cjs) within the match threshold, in any of 8
//    orientations or as a centre crop; all matching pairs are joined (union-find), so a group can
//    hold photos less alike than the threshold — those are flagged "check before removing".
// Fingerprints, sharpness and brightness come from the cached preview; everything is cached in
// duplicates.json so after the first pass only new or changed files are read.

const VERSION = 2
const FULL_HASH_MAX = 32 * 1024 * 1024 // smaller files are hashed whole; bigger ones (videos) sampled
const SAMPLE = 64 * 1024
const SAMPLES = 32
const CONCURRENCY = 4
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'dupes-pairs.cjs'), 'utf8')
const THREADS = Math.max(2, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 2))

const COPY_NAME = /(-WA\d+|\bcopy\b|\(\d+\)|^Screenshot|WhatsApp)/i

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

/** Fingerprint + sharpness + brightness from a preview (already upright). */
async function visual(thumb) {
  const { data, info } = await sharp(thumb, { failOn: 'none' })
    .resize(sig.ANALYSIS_SIZE, sig.ANALYSIS_SIZE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const gray = info.channels === 1 ? data : extractChannel(data, info.channels)
  let tiny = null
  if (info.width < sig.GRID || info.height < sig.GRID) {
    const t = await sharp(thumb, { failOn: 'none' }).resize(sig.GRID, sig.GRID, { fit: 'fill' }).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true })
    tiny = t.info.channels === 1 ? t.data : extractChannel(t.data, t.info.channels)
  }
  return { ...sig.analyze(gray, info.width, info.height, tiny), aspect: info.width / info.height }
}

const extractChannel = (data, channels) => {
  const out = new Uint8Array(data.length / channels)
  for (let i = 0; i < out.length; i++) out[i] = data[i * channels]
  return out
}

async function dimensions(item) {
  if (item.type !== 'image') return null
  try {
    const m = await sharp(item.path, { failOn: 'none' }).metadata()
    if (m.width && m.height) return [m.width, m.height]
  } catch {}
  try {
    if (item.ext === 'bmp') {
      const fh = await fsp.open(item.path, 'r')
      const b = Buffer.alloc(26)
      await fh.read(b, 0, 26, 0)
      await fh.close()
      return [b.readInt32LE(18), Math.abs(b.readInt32LE(22))]
    }
    const d = await exifr.parse(item.path, { tiff: true, exif: true, gps: false, xmp: false, icc: false, iptc: false, ifd1: false })
    const w = d?.ExifImageWidth ?? d?.ImageWidth
    const h = d?.ExifImageHeight ?? d?.ImageHeight
    if (w && h) return [w, h]
  } catch {}
  return null
}

async function pool(list, limit, fn) {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (i < list.length) await fn(list[i++])
    }),
  )
}

/** All pairs of fingerprints within `maxDist`, on several worker threads. */
function findPairs(words, crops, n, maxDist, findCrops) {
  if (n < 2) return Promise.resolve([])
  const threads = Math.min(THREADS, Math.max(1, Math.floor(n / 200)))
  return Promise.all(
    Array.from(
      { length: threads },
      (_, start) =>
        new Promise((resolve) => {
          const worker = new Worker(WORKER_SRC, { eval: true })
          worker.once('message', (pairs) => {
            resolve(pairs)
            worker.terminate()
          })
          worker.once('error', () => resolve(new Int32Array(0)))
          worker.postMessage({ words, crops, n, maxDist, findCrops, start, step: threads })
        }),
    ),
  )
}

class UnionFind {
  constructor(n) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i)
  }
  find(i) {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]]
      i = this.parent[i]
    }
    return i
  }
  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
}

class Duplicates extends EventEmitter {
  constructor(file, { canRun, thumb }) {
    super()
    this.file = file
    this.canRun = canRun
    this.thumb = thumb // item -> Promise<Buffer | null> (cached thumbnail)
    this.records = new Map() // id -> { m, z, x?, s?, c, lo, sh, br, a, d? }
    this.dismissed = new Set()
    this.items = []
    this.settings = { sensitivity: 90, findCrops: true, folders: [] }
    this.result = { groups: [] }
    this.progress = { running: false, phase: 'idle', done: 0, total: 0 }
    this.running = false
    this.again = false
    this.timers = {}
  }

  async load() {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      this.dismissed = new Set(data.dismissed ?? [])
      if (data.version !== VERSION) return
      for (const [id, r] of Object.entries(data.items)) this.records.set(id, r)
    } catch {}
  }

  serialize() {
    return JSON.stringify({ version: VERSION, items: Object.fromEntries(this.records), dismissed: [...this.dismissed] })
  }

  saveSoon(ms = 10_000) {
    if (this.timers.save) return
    this.timers.save = setTimeout(() => this.save(), ms)
  }

  async save() {
    clearTimeout(this.timers.save)
    this.timers.save = null
    try {
      const tmp = `${this.file}.tmp`
      await fsp.writeFile(tmp, this.serialize())
      await fsp.rename(tmp, this.file)
    } catch (err) {
      console.error('Failed to save duplicates cache', err)
    }
  }

  saveNow() {
    if (!this.timers.save) return
    clearTimeout(this.timers.save)
    this.timers.save = null
    try {
      fs.writeFileSync(this.file, this.serialize())
    } catch {}
  }

  /** Match threshold (80–99 %), crop matching and the library folder order (for keep priority). */
  configure(settings) {
    const next = { ...this.settings, ...settings }
    next.sensitivity = Math.round(Math.min(99, Math.max(80, Number(next.sensitivity) || 90)))
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings)
    this.settings = next
    if (changed && this.items.length && !this.running) this.regroup().catch((err) => console.error('[duplicates] regroup failed', err))
  }

  /** Called whenever the library changes; the scan itself waits until previews are done. */
  sync(items) {
    this.items = items
    clearTimeout(this.timers.sync)
    this.timers.sync = setTimeout(() => this.pump(), 1500)
  }

  pump() {
    if (this.disposed || !this.items.length || !this.canRun()) return
    if (this.running) {
      this.again = true
      return
    }
    this.run().catch((err) => console.error('[duplicates] scan failed', err))
  }

  setProgress(phase, done, total) {
    this.progress = { running: phase !== 'idle', phase, done, total }
    if (this.timers.progress) return
    this.timers.progress = setTimeout(() => {
      this.timers.progress = null
      this.emit('progress', this.progress)
    }, 300)
  }

  rec(it) {
    let r = this.records.get(it.id)
    if (!r) this.records.set(it.id, (r = { m: it.mtime, z: it.size }))
    return r
  }

  async run() {
    this.running = true
    try {
      const items = this.items
      const live = new Map(items.map((it) => [it.id, it]))
      for (const [id, r] of this.records) {
        const it = live.get(id)
        if (!it || it.mtime !== r.m || it.size !== r.z) this.records.delete(id)
      }

      // 1. exact copies: only files sharing a size can be identical
      const bySize = new Map()
      for (const it of items) {
        if (!it.size) continue
        let list = bySize.get(it.size)
        if (!list) bySize.set(it.size, (list = []))
        list.push(it)
      }
      const toHash = []
      for (const list of bySize.values()) if (list.length > 1) for (const it of list) if (!this.rec(it).x) toHash.push(it)
      let done = 0
      this.setProgress('hashing', 0, toHash.length)
      await pool(toHash, 2, async (it) => {
        if (this.disposed) return
        try {
          this.rec(it).x = await contentHash(it.path, it.size)
        } catch {}
        this.setProgress('hashing', ++done, toHash.length)
        this.saveSoon()
      })

      // 2. fingerprint, sharpness and brightness of every preview
      const toLook = items.filter((it) => this.rec(it).s === undefined)
      done = 0
      this.setProgress('comparing', 0, toLook.length)
      await pool(toLook, CONCURRENCY, async (it) => {
        if (this.disposed) return
        const r = this.rec(it)
        try {
          const thumb = await this.thumb(it)
          if (!thumb) r.s = null
          else {
            const v = await visual(thumb)
            Object.assign(r, { s: sig.toBase64(v.words), c: v.crops ? 1 : 0, lo: v.lowDetail ? 1 : 0, a: +v.aspect.toFixed(4) })
            if (it.type === 'image') Object.assign(r, { sh: v.sharpness, br: v.brightness })
          }
        } catch {
          r.s = null // no preview: nothing to compare (until the file changes)
        }
        this.setProgress('comparing', ++done, toLook.length)
        this.saveSoon()
      })

      await this.regroup()
      this.saveSoon(2000)
    } finally {
      this.running = false
      this.setProgress('idle', 0, 0)
      if (this.again) {
        this.again = false
        this.pump()
      }
    }
  }

  /** Re-forms the groups from cached facts (also after changing the match threshold). */
  async regroup() {
    const items = this.items
    const maxDist = sig.maxDistanceFor(this.settings.sensitivity / 100)
    const index = new Map(items.map((it, i) => [it.id, i]))
    const uf = new UnionFind(items.length)

    // exact copies
    const byHash = new Map()
    items.forEach((it, i) => {
      const x = this.records.get(it.id)?.x
      if (!x) return
      const key = `${it.size}:${x}`
      if (byHash.has(key)) uf.union(byHash.get(key), i)
      else byHash.set(key, i)
    })

    // look-alike photos (not blank ones: those would match everything)
    const words = new Map()
    const photos = []
    for (const it of items) {
      const r = this.records.get(it.id)
      if (!r?.s || r.lo) continue
      words.set(it.id, sig.fromBase64(r.s))
      if (it.type === 'image') photos.push(it)
    }
    const flat = new Uint32Array(photos.length * sig.WORDS)
    const crops = new Uint8Array(photos.length)
    photos.forEach((it, i) => {
      flat.set(words.get(it.id), i * sig.WORDS)
      crops[i] = this.records.get(it.id).c ? 1 : 0
    })
    for (const part of await findPairs(flat, crops, photos.length, maxDist, this.settings.findCrops)) {
      for (let k = 0; k < part.length; k += 2) uf.union(index.get(photos[part[k]].id), index.get(photos[part[k + 1]].id))
    }

    // look-alike videos (for now from their preview frame; same length within 1.5 s or 3 %)
    const videos = items.filter((it) => it.type === 'video' && words.has(it.id))
    for (let i = 0; i < videos.length; i++) {
      const a = videos[i]
      for (let j = i + 1; j < videos.length; j++) {
        const b = videos[j]
        if (a.duration && b.duration && Math.abs(a.duration - b.duration) > Math.max(1.5, 0.03 * Math.max(a.duration, b.duration))) continue
        const wa = words.get(a.id)
        const wb = words.get(b.id)
        const d = sig.popcount(wa[0] ^ wb[0]) + sig.popcount(wa[1] ^ wb[1]) + sig.popcount(wa[16] ^ wb[16]) + sig.popcount(wa[17] ^ wb[17])
        if (d <= maxDist) uf.union(index.get(a.id), index.get(b.id))
      }
    }

    // groups
    const sets = new Map()
    items.forEach((it, i) => {
      const root = uf.find(i)
      let list = sets.get(root)
      if (!list) sets.set(root, (list = []))
      list.push(it)
    })
    const raw = [...sets.values()]
      .filter((list) => list.length > 1)
      .map((list) => list.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase())))

    // sizes of grouped photos (for "best quality")
    const needDims = raw.flat().filter((it) => it.type === 'image' && this.records.get(it.id) && this.records.get(it.id).d === undefined)
    await pool(needDims, CONCURRENCY, async (it) => {
      const r = this.records.get(it.id)
      if (r) r.d = (await dimensions(it)) ?? null
    })

    const groups = raw
      .map((list) => this.describe(list, words))
      .filter((g) => !this.dismissed.has(g.ids.slice().sort().join(',')))
      .sort((a, b) => Number(b.exact) - Number(a.exact) || a.first.localeCompare(b.first))
    groups.forEach((g, i) => {
      g.n = i + 1
      delete g.first
    })
    this.result = { groups }
    this.emit('changed')
  }

  folderPriority(it) {
    const p = it.path.toLowerCase()
    const i = this.settings.folders.findIndex((f) => p.startsWith(f.toLowerCase().replace(/[\\/]+$/, '') + path.sep))
    return i < 0 ? this.settings.folders.length : i
  }

  /** One group: kind, best copy, how every file relates to it, and the keep order for each rule. */
  describe(list, words) {
    const recs = list.map((it) => this.records.get(it.id) ?? {})
    const pixels = (i) => (recs[i].d ? recs[i].d[0] * recs[i].d[1] : 0)
    const sharp = (i) => (Number.isFinite(recs[i].sh) ? recs[i].sh : -1)
    const maxSharp = Math.max(0, ...list.map((_, i) => sharp(i)))
    const step = (i) => (maxSharp > 0 && sharp(i) > 0 ? Math.round((sharp(i) / maxSharp) * 5) : 0)
    const copy = (i) => (COPY_NAME.test(path.basename(list[i].name, path.extname(list[i].name))) ? 1 : 0)
    const prio = list.map((it) => this.folderPriority(it))
    const w = (i) => words.get(list[i].id)
    // a cropped version never wins over the full photo it was cut from
    const isCrop = list.map((_, i) =>
      w(i) ? list.some((_, j) => j !== i && w(j) && recs[j].c && sig.isCropOf(w(i), w(j), true)) : false,
    )
    const tail = (a, b) =>
      copy(a) - copy(b) ||
      prio[a] - prio[b] ||
      list[a].date - list[b].date ||
      list[a].name.length - list[b].name.length ||
      list[a].path.toLowerCase().localeCompare(list[b].path.toLowerCase())
    const order = (cmp, crops) =>
      list
        .map((_, i) => i)
        .sort((a, b) => (crops ? Number(isCrop[a]) - Number(isCrop[b]) : 0) || cmp(a, b) || tail(a, b))
    const orders = [
      order((a, b) => pixels(b) - pixels(a) || step(b) - step(a) || copy(a) - copy(b) || list[b].size - list[a].size, true),
      order((a, b) => sharp(b) - sharp(a) || pixels(b) - pixels(a), true),
      order((a, b) => list[b].size - list[a].size || pixels(b) - pixels(a), false),
      order((a, b) => list[a].date - list[b].date || pixels(b) - pixels(a), false),
      order((a, b) => list[b].date - list[a].date || pixels(b) - pixels(a), false),
    ]
    const ref = orders[0][0]
    const exact = recs.every((r) => r.x && r.x === recs[0].x)
    let min = 1
    const info = list.map((it, i) => {
      if (i === ref) return ['best']
      if (recs[i].x && recs[i].x === recs[ref].x) return ['identical']
      if (w(i) && w(ref)) {
        const c = sig.compare(w(ref), !!recs[ref].c, w(i), !!recs[i].c)
        const s = 1 - c.distance / sig.BITS
        min = Math.min(min, s)
        return [+s.toFixed(3), c.kind, c.kind === 'rotated' ? c.rotation : 0]
      }
      return ['']
    })
    // "Sharpest": only between shots of the same resolution (bursts, re-takes)
    const ranked = list.map((_, i) => i).filter((i) => sharp(i) > 0).sort((a, b) => sharp(b) - sharp(a))
    const clear =
      !exact &&
      ranked.length >= 2 &&
      sharp(ranked[0]) > sharp(ranked[1]) * 1.15 &&
      ranked.every((i) => Math.abs(pixels(i) - pixels(ranked[0])) <= pixels(ranked[0]) * 0.1)
    return {
      ids: list.map((it) => it.id),
      exact,
      video: list.every((it) => it.type === 'video'),
      ref,
      min: +min.toFixed(3),
      info,
      orders,
      sharpest: clear ? ranked[0] : -1,
      first: list[0].path.toLowerCase(),
    }
  }

  /** "These aren't duplicates": hide this group (it comes back if its members change). */
  dismiss(ids) {
    const key = [...ids].sort().join(',')
    this.dismissed.add(key)
    this.result = { groups: this.result.groups.filter((g) => g.ids.slice().sort().join(',') !== key) }
    this.saveSoon(1000)
    this.emit('changed')
  }

  /** The current groups, plus quality facts of every analysed item: id → [sharpness, brightness, blank, w, h]. */
  snapshot() {
    const facts = {}
    for (const it of this.items) {
      const r = this.records.get(it.id)
      if (!r || r.s === undefined) continue
      facts[it.id] = [r.sh ?? -1, r.br ?? -1, r.lo ? 1 : 0, r.d?.[0] ?? 0, r.d?.[1] ?? 0]
    }
    return { groups: this.result.groups, facts, sensitivity: this.settings.sensitivity, findCrops: this.settings.findCrops }
  }

  /** Group members, for carrying dates over to kept copies. */
  groupsOf(ids) {
    const want = new Set(ids)
    return this.result.groups.filter((g) => g.ids.some((id) => want.has(id)))
  }

  progressInfo() {
    return this.progress
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timers.sync)
    this.saveNow()
  }
}

module.exports = { Duplicates }
