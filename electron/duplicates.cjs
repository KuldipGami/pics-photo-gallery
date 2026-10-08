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
const { writeAtomic, writeAtomicSync, serial, readJson } = require('./safe-file.cjs')
const { findVideoPairsAsync, sameLength, alignOffset, DENSE_INTERVAL } = require('./video-frames.cjs')

// Duplicate detection, ported from DupeLens:
//  - exact copies: same size + same content hash
//  - look-alikes: perceptual fingerprints (signature.cjs) within the match threshold, in any of 8
//    orientations or as a centre crop; all matching pairs are joined (union-find), so a group can
//    hold photos less alike than the threshold — those are flagged "check before removing".
//  - look-alike videos: DupeLens' VideosMatch on frames read from the videos themselves
//    (video-frames.cjs): same-length copies by 6 sampled frames, trimmed clips by lining up a
//    frame per second. Until a video has been read, its preview frame stands in.
// Fingerprints, sharpness and brightness come from the cached preview; everything is cached in
// duplicates.json so after the first pass only new or changed files are read (video frames live
// in their own binary sidecar, see video-frames.cjs).

const VERSION = 2
const FULL_HASH_MAX = 32 * 1024 * 1024 // smaller files are hashed whole; bigger ones (videos) sampled
const SAMPLE = 64 * 1024
const SAMPLES = 32
const CONCURRENCY = 4
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'dupes-pairs.cjs'), 'utf8')
const THREADS = Math.max(2, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 2))

const COPY_NAME = /(-WA\d+|\bcopy\b|\(\d+\)|^Screenshot|WhatsApp)/i
const CONFIGURE_MS = 400 // the sensitivity slider: regroup once it has rested this long

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

/** What findPairs is asked (the photos in order, their fingerprints, the settings) and how it answers. */
function pairsKey(photos, flat, crops, maxDist, findCrops) {
  const h = crypto.createHash('sha1')
  h.update(WORKER_SRC)
  h.update(`${maxDist}|${findCrops ? 1 : 0}|${photos.map((it) => it.id).join(',')}`)
  h.update(new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength))
  h.update(crops)
  return h.digest('base64')
}

// The last photo pairs are kept on disk too (duplicates-pairs.bin: 'LDP2', key length, key, number
// of values, pairs as int32), so a launch with no new photos doesn't compare them all again on
// every core for seconds. (LDP1 had no count: a file mixed from two saves could pass for whole.)
const PAIRS_MAGIC = 'LDP2'

async function readPairs(file, key) {
  try {
    const buf = await fsp.readFile(file)
    if (buf.toString('latin1', 0, 4) !== PAIRS_MAGIC) return null
    const len = buf.readUInt32LE(4)
    if (buf.toString('utf8', 8, 8 + len) !== key) return null
    const count = buf.readUInt32LE(8 + len)
    const start = 12 + len
    if (count % 2 || buf.length !== start + count * 4) return null // incomplete: compare again
    const pairs = new Int32Array(count)
    for (let i = 0; i < pairs.length; i++) pairs[i] = buf.readInt32LE(start + i * 4)
    return [pairs]
  } catch {
    return null
  }
}

async function writePairs(file, key, parts) {
  const k = Buffer.from(key, 'utf8')
  const total = parts.reduce((n, p) => n + p.length, 0)
  const buf = Buffer.alloc(12 + k.length + total * 4)
  buf.write(PAIRS_MAGIC, 0, 'latin1')
  buf.writeUInt32LE(k.length, 4)
  k.copy(buf, 8)
  buf.writeUInt32LE(total, 8 + k.length)
  let at = 12 + k.length
  for (const p of parts) for (const v of p) at = buf.writeInt32LE(v, at)
  await writeAtomic(file, buf).catch(() => {}) // only a cache: next time it's worked out again
}

/** All pairs of fingerprints within `maxDist`, on several worker threads (null for a part whose worker failed). */
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
          worker.once('error', () => resolve(null))
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
  /**
   * `videoFrames` (optional): a VideoFrames (video-frames.cjs). Duplicates loads, syncs, starts
   * (after its own pass) and disposes it, and regroups as its results come in.
   */
  constructor(file, { canRun, thumb, videoFrames = null }) {
    super()
    this.file = file
    this.canRun = canRun
    this.thumb = thumb // item -> Promise<Buffer | null> (cached thumbnail)
    this.videoFrames = videoFrames
    this.memo = new Map() // video alignments for describe(), keyed by both files' versions
    videoFrames?.on('changed', () => this.regroupSoon())
    this.records = new Map() // id -> { m, z, x?, s?, c, lo, sh, br, a, d? }
    this.decoded = new Map() // id -> { s, w }: a record's fingerprint, decoded
    this.photoPairs = null // { key, parts }: the last findPairs answer and what it was for
    this.pairsFile = file.replace(/\.json$/i, '') + '-pairs.bin'
    this.dismissed = new Set()
    this.items = []
    this.settings = { sensitivity: 90, findCrops: true, folders: [] }
    this.result = { groups: [] }
    this.progress = { running: false, phase: 'idle', done: 0, total: 0 }
    this.running = false
    this.again = false
    this.timers = {}
    this.dirty = false // changes not on disk yet
    this.blocked = false // duplicates.json couldn't be read: don't save over it this session
    this.regrouping = null // the regroup in progress (one at a time)
    this.asked = 0 // regroups asked for…
    this.formed = 0 // …and the newest one whose result is shown
    this.writer = serial(async () => {
      const text = this.serialize()
      this.writing = true
      try {
        await writeAtomic(this.file, text)
      } finally {
        this.writing = false
        this.rewriteIfFlushed()
      }
    })
  }

  async load() {
    await this.videoFrames?.load()
    const r = await readJson(this.file)
    if (r.error) {
      this.blocked = true
      console.error('[duplicates] duplicates.json could not be read; not saving over it this session', r.error)
      return
    }
    if (r.corrupt) console.error(`[duplicates] duplicates.json was damaged (kept as ${r.keptAs}); checking again`)
    const data = r.data
    if (!data || typeof data !== 'object') return
    this.dismissed = new Set(Array.isArray(data.dismissed) ? data.dismissed.filter((k) => typeof k === 'string') : [])
    if (data.version !== VERSION || !data.items || typeof data.items !== 'object') return
    for (const [id, rec] of Object.entries(data.items)) if (rec && typeof rec === 'object') this.records.set(id, rec)
  }

  serialize() {
    return JSON.stringify({ version: VERSION, items: Object.fromEntries(this.records), dismissed: [...this.dismissed] })
  }

  saveSoon(ms = 10_000) {
    this.dirty = true
    if (this.timers.save || this.disposed) return
    this.timers.save = setTimeout(() => this.save(), ms)
  }

  async save() {
    clearTimeout(this.timers.save)
    this.timers.save = null
    if (this.blocked) return
    this.dirty = false
    try {
      await this.writer()
    } catch (err) {
      console.error('Failed to save duplicates cache', err)
      this.saveSoon(60_000) // still owed: again later, and at quit
    }
  }

  saveNow() {
    if (this.blocked || (!this.dirty && !this.writing)) return
    clearTimeout(this.timers.save)
    this.timers.save = null
    try {
      writeAtomicSync(this.file, this.serialize())
      this.dirty = false
    } catch (err) {
      console.error('Failed to save duplicates cache', err)
    }
    // a save still on its way would land after this one, with older data: it writes this again then
    if (this.writing) this.flushed = true
  }

  rewriteIfFlushed() {
    if (!this.flushed) return
    this.flushed = false
    try {
      writeAtomicSync(this.file, this.serialize())
    } catch {}
  }

  /**
   * Files Lumen moved or renamed (`ids`: Map old id → new id): their cached facts follow them, and
   * so do "not duplicates" choices (a dismissed group is known by its members' ids).
   */
  remapIds(ids) {
    let changed = false
    for (const [oldId, newId] of ids) {
      if (oldId === newId || !this.records.has(oldId)) continue
      this.records.set(newId, this.records.get(oldId))
      this.records.delete(oldId)
      changed = true
    }
    const dismissed = new Set()
    for (const key of this.dismissed) {
      const parts = key.split(',')
      const moved = parts.map((id) => ids.get(id) ?? id)
      if (moved.some((id, i) => id !== parts[i])) changed = true
      dismissed.add(moved.sort().join(','))
    }
    this.dismissed = dismissed
    if (changed) this.saveSoon(2000)
  }

  /** Match threshold (80–99 %), crop matching and the library folder order (for keep priority). */
  configure(settings) {
    const next = { ...this.settings, ...settings }
    next.sensitivity = Math.round(Math.min(99, Math.max(80, Number(next.sensitivity) || 90)))
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings)
    this.settings = next
    if (!changed || !this.items.length) return
    // Dragging the sensitivity slider calls this at every step: regroup once, when it rests.
    clearTimeout(this.timers.configure)
    this.timers.configure = setTimeout(() => {
      if (this.disposed) return
      if (this.running) this.again = true // the scan in progress goes round once more
      else this.regroup().catch((err) => console.error('[duplicates] regroup failed', err))
    }, CONFIGURE_MS)
  }

  /** Called whenever the library changes; the scan itself waits until previews are done. */
  sync(items) {
    this.items = items
    this.videoFrames?.sync(items)
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
      } else if (!this.disposed) {
        // then read the videos' frames (slow; in the background, only while previews are done)
        this.videoFrames?.pump()
      }
    }
  }

  /** New video frames arrived: re-form the groups (not while a scan runs: it regroups anyway). */
  regroupSoon() {
    if (this.disposed || !this.items.length) return
    if (this.running) {
      this.again = true
      return
    }
    clearTimeout(this.timers.regroup)
    this.timers.regroup = setTimeout(() => {
      if (this.running || this.disposed) return
      this.regroup().catch((err) => console.error('[duplicates] regroup failed', err))
    }, 1000)
  }

  /**
   * Re-forms the groups from cached facts (also after changing the match threshold). One runs at a
   * time: asked again meanwhile, it runs once more afterwards, and a result that was already out of
   * date when it was ready (the threshold moved again, new frames came in) isn't shown.
   */
  regroup() {
    this.asked++
    if (!this.regrouping) {
      this.regrouping = (async () => {
        try {
          while (this.formed < this.asked && !this.disposed) {
            const ask = this.asked
            await this.form(ask)
            this.formed = ask
          }
        } finally {
          this.regrouping = null
        }
      })()
    }
    return this.regrouping
  }

  /** One regroup (see regroup()); `ask` is its number, to tell whether a newer one is wanted. */
  async form(ask) {
    const stale = () => this.asked !== ask || this.disposed
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
    const decoded = new Map() // fingerprints decoded once, not on every regroup
    for (const it of items) {
      const r = this.records.get(it.id)
      if (!r?.s || r.lo) continue
      let d = this.decoded.get(it.id)
      if (d?.s !== r.s) d = { s: r.s, w: sig.fromBase64(r.s) }
      decoded.set(it.id, d)
      words.set(it.id, d.w)
      if (it.type === 'image') photos.push(it)
    }
    this.decoded = decoded
    const flat = new Uint32Array(photos.length * sig.WORDS)
    const crops = new Uint8Array(photos.length)
    photos.forEach((it, i) => {
      flat.set(words.get(it.id), i * sig.WORDS)
      crops[i] = this.records.get(it.id).c ? 1 : 0
    })
    // Comparing every photo with every other takes several seconds on all cores; while only videos
    // change (their frames are read for hours on a first run), the photos' pairs are the same.
    const key = pairsKey(photos, flat, crops, maxDist, this.settings.findCrops)
    let parts = this.photoPairs?.key === key ? this.photoPairs.parts : await readPairs(this.pairsFile, key)
    if (parts) this.photoPairs = { key, parts }
    else {
      parts = await findPairs(flat, crops, photos.length, maxDist, this.settings.findCrops)
      // (a failed worker: try again next time)
      if (parts.every(Boolean)) {
        this.photoPairs = { key, parts }
        if (!this.disposed) writePairs(this.pairsFile, key, parts)
      }
      parts = parts.filter(Boolean)
    }
    if (stale()) return
    for (const part of parts) {
      for (let k = 0; k < part.length; k += 2) uf.union(index.get(photos[part[k]].id), index.get(photos[part[k + 1]].id))
    }

    // look-alike videos (DupeLens' VideosMatch, see video-frames.cjs): same length within 1.5 s or
    // 3 %: the 6 sampled frames; a shorter clip of 6 s or more: lined up inside the longer one.
    // A video whose analysis failed is only matched as an exact copy.
    const analysed = []
    const waiting = []
    for (const it of items) {
      if (it.type !== 'video') continue
      const f = this.videoFrames?.get(it)
      if (f) {
        if (f.s) analysed.push(it)
      } else if (words.has(it.id)) waiting.push(it)
    }
    if (analysed.length > 1) {
      const input = analysed.map((it) => {
        const f = this.videoFrames.get(it)
        return { d: f.d, s: f.s, x: f.x }
      })
      const { pairs } = await findVideoPairsAsync(input, maxDist)
      if (stale()) return
      for (const [a, b] of pairs) uf.union(index.get(analysed[a].id), index.get(analysed[b].id))
    }
    // Not read yet: for now the preview frame stands in (same length only), as before.
    // (Lengths and the four compared words are looked up once per video, not once per pair:
    // with thousands of videos waiting that's millions of lookups.)
    const previewed = [...waiting, ...analysed.filter((it) => words.has(it.id))]
    const length = (it) => this.videoFrames?.get(it)?.d || it.duration
    const n = previewed.length
    const lens = new Float64Array(n)
    const w0 = new Uint32Array(n)
    const w1 = new Uint32Array(n)
    const w16 = new Uint32Array(n)
    const w17 = new Uint32Array(n)
    previewed.forEach((it, j) => {
      const w = words.get(it.id)
      lens[j] = length(it) || 0
      w0[j] = w[0]
      w1[j] = w[1]
      w16[j] = w[16]
      w17[j] = w[17]
    })
    for (let i = 0; i < waiting.length; i++) {
      const la = lens[i]
      for (let j = i + 1; j < n; j++) {
        const lb = lens[j]
        if (la && lb && !sameLength(la, lb)) continue
        const d = sig.popcount(w0[i] ^ w0[j]) + sig.popcount(w1[i] ^ w1[j]) + sig.popcount(w16[i] ^ w16[j]) + sig.popcount(w17[i] ^ w17[j])
        if (d <= maxDist) uf.union(index.get(waiting[i].id), index.get(previewed[j].id))
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
    if (stale()) return

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
    // videos: frame fingerprints, length and size as read by video-frames.cjs
    const vf = list.map((it) => (it.type === 'video' ? this.videoFrames?.get(it) : undefined))
    const pixels = (i) => (recs[i].d ? recs[i].d[0] * recs[i].d[1] : vf[i]?.w ? vf[i].w * vf[i].h : 0)
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
      if (vf[i]?.s && vf[ref]?.s) {
        // DupeLens: a trimmed clip by how well it lines up inside the longer video, else frame by frame
        const a = vf[ref]
        const b = vf[i]
        const trimmed = !sameLength(a.d, b.d)
        let s
        if (trimmed && a.x && b.x) {
          const key = `fit|${list[ref].id}:${list[ref].mtime}|${list[i].id}:${list[i].mtime}`
          if (!this.memo.has(key)) this.memo.set(key, a.d > b.d ? sig.bestAlignment(a.x, b.x) : sig.bestAlignment(b.x, a.x))
          s = 1 - this.memo.get(key) / sig.BITS
        } else s = 1 - sig.framesDistance(a.s, b.s) / sig.BITS
        min = Math.min(min, s)
        return [+s.toFixed(3), trimmed ? (b.d < a.d ? 'trimmed' : 'longer') : 'same', 0]
      }
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
    const video = list.every((it) => it.type === 'video')
    return {
      ids: list.map((it) => it.id),
      exact,
      video,
      ref,
      min: +min.toFixed(3),
      info,
      orders,
      sharpest: clear ? ranked[0] : -1,
      ...(video ? { offsets: this.videoOffsets(list, vf) } : {}),
      first: list[0].path.toLowerCase(),
    }
  }

  /**
   * Videos: where each clip starts on the longest clip's timeline (seconds), so that they can play
   * in sync (a trimmed copy starts later). DupeLens: lined up on the per-second frames.
   */
  videoOffsets(list, vf) {
    const length = (i) => vf[i]?.d || list[i].duration || 0
    let longest = 0
    list.forEach((_, i) => {
      if (length(i) > length(longest)) longest = i
    })
    return list.map((it, i) => {
      const a = vf[longest]?.x
      const b = vf[i]?.x
      if (i === longest || !a || !b || length(longest) - length(i) <= 1.5) return 0
      const key = `offset|${list[longest].id}:${list[longest].mtime}|${it.id}:${it.mtime}`
      if (!this.memo.has(key)) this.memo.set(key, alignOffset(a, b) * DENSE_INTERVAL)
      return this.memo.get(key)
    })
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
      const v = it.type === 'video' ? this.videoFrames?.get(it) : undefined // a video's size, as decoded
      facts[it.id] = [r.sh ?? -1, r.br ?? -1, r.lo ? 1 : 0, r.d?.[0] ?? v?.w ?? 0, r.d?.[1] ?? v?.h ?? 0]
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
    clearTimeout(this.timers.regroup)
    clearTimeout(this.timers.configure)
    this.videoFrames?.dispose()
    this.saveNow()
  }
}

module.exports = { Duplicates }
