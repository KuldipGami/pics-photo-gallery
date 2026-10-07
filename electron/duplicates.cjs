const fs = require('node:fs')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const sharp = require('sharp')
const exifr = require('exifr')

const FULL_HASH_MAX = 32 * 1024 * 1024 // smaller files are hashed whole; bigger ones (videos) sampled
const SAMPLE = 64 * 1024
const SAMPLES = 32
const NEAR_BITS = 10 // of 128: looks the same (resized / re-saved / burst shot)
const MIN_DETAIL = 6 // greyscale std-dev: flat images (black frames, plain sky) don't compare
const AR_TOLERANCE = 0.04
const CONCURRENCY = 4
const VERSION = 1

const COPY_NAME = /\(\d+\)|[-_ ]copy\b|\bcopy of\b|kopie|\bcopy\d*\b/i
const COPY_DIR = /whatsapp|download|backup|\btemp\b|\bcopy\b|\bsent\b|telegram|received|cache/i

/**
 * Bytes identical? Same size and the same content hash: whole-file SHA-1 for photos; for big files
 * the size plus head, tail and 32 evenly spaced 64 KB samples (two different videos never match on
 * all of those).
 */
async function contentHash(file, size) {
  const h = crypto.createHash('sha1')
  h.update(String(size))
  if (size <= FULL_HASH_MAX) {
    // streamed in 1 MB chunks, so hashing never blocks the main process for long
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

/**
 * 128-bit difference hash of a thumbnail (horizontal + vertical gradients on a 9×9 greyscale),
 * plus aspect ratio and how much detail there is.
 */
async function visualHash(thumb) {
  const meta = await sharp(thumb).metadata()
  const { data } = await sharp(thumb).greyscale().resize(9, 9, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true })
  const words = new Uint32Array(4)
  let bit = 0
  const set = (on) => {
    if (on) words[bit >> 5] |= 1 << (bit & 31)
    bit++
  }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) set(data[y * 9 + x] < data[y * 9 + x + 1])
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) set(data[y * 9 + x] < data[(y + 1) * 9 + x])
  let mean = 0
  for (const v of data) mean += v
  mean /= data.length
  let variance = 0
  for (const v of data) variance += (v - mean) ** 2
  return {
    p: Array.from(words),
    a: +(meta.width / meta.height).toFixed(4),
    v: +Math.sqrt(variance / data.length).toFixed(1),
  }
}

const popcount = (n) => {
  n -= (n >>> 1) & 0x55555555
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

async function dimensions(item) {
  if (item.type !== 'image') return null
  try {
    const m = await sharp(item.path, { failOn: 'none' }).metadata()
    if (m.width && m.height) return (m.orientation ?? 1) >= 5 ? [m.height, m.width] : [m.width, m.height]
  } catch {}
  try {
    const d = await exifr.parse(item.path, { tiff: true, exif: true, gps: false, xmp: false, icc: false, iptc: false })
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

/**
 * Finds exact copies (identical bytes) and look-alikes (the same picture resized, re-saved, edited
 * or shot in a burst) across the library. Hashes are cached in duplicates.json, so after the
 * first pass only new or changed files are read.
 */
class Duplicates extends EventEmitter {
  constructor(file, { canRun, thumb }) {
    super()
    this.file = file
    this.canRun = canRun
    this.thumb = thumb // item -> Promise<Buffer | null> (cached thumbnail)
    this.records = new Map() // id -> { m, z, x?, p?, a?, v?, d?: [w, h] }
    this.dismissed = new Set()
    this.items = []
    this.result = { exact: [], similar: [] }
    this.progress = { running: false, phase: 'idle', done: 0, total: 0 }
    this.running = false
    this.again = false
    this.timers = {}
  }

  async load() {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      if (data.version !== VERSION) return
      for (const [id, r] of Object.entries(data.items)) this.records.set(id, r)
      this.dismissed = new Set(data.dismissed ?? [])
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

  async run() {
    this.running = true
    try {
      const items = this.items
      // forget removed / changed files
      const live = new Map(items.map((it) => [it.id, it]))
      for (const [id, r] of this.records) {
        const it = live.get(id)
        if (!it || it.mtime !== r.m || it.size !== r.z) this.records.delete(id)
      }
      const rec = (it) => {
        let r = this.records.get(it.id)
        if (!r) this.records.set(it.id, (r = { m: it.mtime, z: it.size }))
        return r
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
      for (const list of bySize.values()) if (list.length > 1) for (const it of list) if (!rec(it).x) toHash.push(it)
      let done = 0
      this.setProgress('hashing', 0, toHash.length)
      await pool(toHash, 2, async (it) => {
        try {
          rec(it).x = await contentHash(it.path, it.size)
        } catch {}
        this.setProgress('hashing', ++done, toHash.length)
        this.saveSoon()
      })

      // 2. look-alikes: a visual fingerprint of every preview
      const toLook = items.filter((it) => rec(it).p === undefined)
      done = 0
      this.setProgress('comparing', 0, toLook.length)
      await pool(toLook, CONCURRENCY, async (it) => {
        try {
          const thumb = await this.thumb(it)
          Object.assign(rec(it), thumb ? await visualHash(thumb) : { p: null })
        } catch {
          rec(it).p = null // no preview: nothing to compare (until the file changes)
        }
        this.setProgress('comparing', ++done, toLook.length)
        this.saveSoon()
      })

      this.result = await this.group(items)
      this.saveSoon(2000)
    } finally {
      this.running = false
      this.setProgress('idle', 0, 0)
      this.emit('changed')
      if (this.again) {
        this.again = false
        this.pump()
      }
    }
  }

  async group(items) {
    const byId = new Map(items.map((it) => [it.id, it]))

    // exact: same size + same content hash
    const byHash = new Map()
    for (const it of items) {
      const x = this.records.get(it.id)?.x
      if (!x) continue
      const key = `${it.size}:${x}`
      let list = byHash.get(key)
      if (!list) byHash.set(key, (list = []))
      list.push(it)
    }
    const exactSets = [...byHash.values()].filter((l) => l.length > 1)
    const copyOf = new Map() // id -> exact set index
    exactSets.forEach((set, i) => set.forEach((it) => copyOf.set(it.id, i)))

    // look-alikes: candidate pairs share at least one of 16 hash bytes (pigeonhole: ≤ 10 differing
    // bits leave ≥ 6 bytes untouched), then the full 128-bit distance decides.
    const hashed = items.filter((it) => {
      const r = this.records.get(it.id)
      return r?.p && r.v >= MIN_DETAIL
    })
    // flat typed arrays: the pair loop below runs millions of times on a big library
    const n = hashed.length
    const P = new Uint32Array(n * 4)
    const AR = new Float64Array(n)
    const VIDEO = new Uint8Array(n)
    const DUR = new Float64Array(n)
    const buckets = Array.from({ length: 16 * 256 }, () => [])
    hashed.forEach((it, i) => {
      const r = this.records.get(it.id)
      P.set(r.p, i * 4)
      AR[i] = r.a
      VIDEO[i] = it.type === 'video' ? 1 : 0
      DUR[i] = it.duration || 0
      for (let b = 0; b < 16; b++) buckets[(b << 8) | ((r.p[b >> 2] >>> ((b & 3) * 8)) & 0xff)].push(i)
    })
    const near = new Map() // idx -> Set(idx)
    const link = (i, j) => {
      if (!near.has(i)) near.set(i, new Set())
      near.get(i).add(j)
    }
    // A pair sharing several bytes is checked once per shared byte: cheaper than remembering pairs.
    for (const list of buckets) {
      if (list.length < 2 || list.length > 400) continue // a huge bucket is a low-detail pattern, not a match
      for (let a = 0; a < list.length; a++) {
        const i = list[a]
        const pi = i * 4
        for (let b = a + 1; b < list.length; b++) {
          const j = list[b]
          if (VIDEO[i] !== VIDEO[j]) continue
          if (Math.abs(AR[i] - AR[j]) > AR_TOLERANCE * Math.max(AR[i], AR[j])) continue
          const pj = j * 4
          const bits =
            popcount(P[pi] ^ P[pj]) + popcount(P[pi + 1] ^ P[pj + 1]) + popcount(P[pi + 2] ^ P[pj + 2]) + popcount(P[pi + 3] ^ P[pj + 3])
          if (bits > NEAR_BITS) continue
          if (VIDEO[i] && DUR[i] && DUR[j] && Math.abs(DUR[i] - DUR[j]) > 1.5) continue
          link(i, j)
          link(j, i)
        }
      }
    }
    // Leader clustering (no chaining): each group is a photo plus everything that looks like it.
    const order = [...near.keys()].sort((x, y) => hashed[x].date - hashed[y].date)
    const taken = new Set()
    const similarSets = []
    for (const lead of order) {
      if (taken.has(lead)) continue
      const members = [lead, ...[...near.get(lead)].filter((j) => !taken.has(j))]
      if (members.length < 2) continue
      const set = members.map((j) => hashed[j])
      // all one exact-copy set: already listed under exact copies
      const sets = new Set(set.map((it) => copyOf.get(it.id) ?? `u${it.id}`))
      if (sets.size < 2) continue
      members.forEach((j) => taken.add(j))
      similarSets.push(set)
    }

    // dimensions (to keep the sharpest look-alike)
    const needDims = similarSets.flat().filter((it) => it.type === 'image' && !this.records.get(it.id)?.d)
    await pool(needDims, CONCURRENCY, async (it) => {
      const d = await dimensions(it)
      const r = this.records.get(it.id)
      if (r) r.d = d ?? [0, 0]
    })

    const signature = (set) => set.map((it) => it.id).sort().join(',')
    const copyPenalty = (it) => (COPY_NAME.test(it.name) ? 2 : 0) + (COPY_DIR.test(it.dir) ? 1 : 0)
    const pixels = (it) => {
      const d = this.records.get(it.id)?.d
      return d ? d[0] * d[1] : 0
    }
    const keepExact = (set) =>
      [...set].sort((a, b) => copyPenalty(a) - copyPenalty(b) || a.added - b.added || a.path.length - b.path.length)[0]
    const keepSimilar = (set) =>
      [...set].sort(
        (a, b) => pixels(b) - pixels(a) || b.size - a.size || copyPenalty(a) - copyPenalty(b) || a.date - b.date,
      )[0]

    const dims = {}
    for (const it of similarSets.flat()) {
      const d = this.records.get(it.id)?.d
      if (d && d[0]) dims[it.id] = d
    }
    const exact = exactSets
      .filter((set) => !this.dismissed.has(signature(set)))
      .map((set) => ({ ids: set.map((it) => it.id), keep: keepExact(set).id, size: set[0].size }))
      .sort((a, b) => b.size * (b.ids.length - 1) - a.size * (a.ids.length - 1))
    const similar = similarSets
      .filter((set) => !this.dismissed.has(signature(set)))
      .map((set) => ({ ids: set.map((it) => it.id), keep: keepSimilar(set).id }))
      .sort((a, b) => byId.get(b.ids[0]).date - byId.get(a.ids[0]).date)
    return { exact, similar, dims }
  }

  /** "These aren't duplicates": hide this group (it comes back if its members change). */
  dismiss(ids) {
    this.dismissed.add([...ids].sort().join(','))
    const drop = (list) => list.filter((g) => g.ids.slice().sort().join(',') !== [...ids].sort().join(','))
    this.result = { ...this.result, exact: drop(this.result.exact), similar: drop(this.result.similar) }
    this.saveSoon(1000)
    this.emit('changed')
  }

  snapshot() {
    const { exact, similar, dims = {} } = this.result
    let exactFiles = 0
    let exactBytes = 0
    for (const g of exact) {
      exactFiles += g.ids.length - 1
      exactBytes += g.size * (g.ids.length - 1)
    }
    return { exact, similar, dims, exactFiles, exactBytes, similarGroups: similar.length }
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
