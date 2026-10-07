const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Worker } = require('node:worker_threads')
const sig = require('./signature.cjs')

// Frame fingerprints of every video, for duplicate detection (ported from DupeLens'
// VideoAnalyzer / MediaScanner.VideosMatch):
//  - summary: 6 frames at duration·(k+0.5)/6, for re-encoded / resized copies of the same length
//  - dense:   a frame every second from 0.5 s (first 20 minutes), for trimmed clips
// Frames are read by a media worker (worker.cjs, through Thumbnails.videoFrames). This module
// paces that work — in the background, one video at a time, only while no previews are being
// made, resumable and cancellable — and keeps the results in a compact binary sidecar
// (video-frames.bin) rather than in duplicates.json. It also holds the matching itself.

const MAGIC = 'LVFP'
const VERSION = 1
const HEADER = 12
const FRAME_WORDS = 4 // 128-bit fingerprint per frame
const SUMMARY_FRAMES = 6
const DENSE_INTERVAL = 1 // s
const MIN_TRIMMED = 6 // s; shorter clips are only matched as same-length copies
const TRIM_FACTOR = 2.5
const CONCURRENCY = 1 // one video at a time: the GPU's decoder is shared with everything on screen
const GAP_MS = 40 // breather between videos
const SAVE_MS = 15_000
const CHANGED_MS = 20_000
const FAILURES_IN_A_ROW = 5 // then something is wrong with the worker itself: stop, retry later

const FLAG_SUMMARY = 1
const FLAG_FAILED = 2

/** DupeLens: lengths within 1.5 s or 3 % count as the same video. */
const sameLength = (a, b) => Math.abs(a - b) <= Math.max(1.5, 0.03 * Math.max(a, b))
/** Per-frame limit for a trimmed clip lining up inside a longer video (DupeLens' TrimLimit). */
const trimLimit = (maxDist) => maxDist * TRIM_FACTOR

/** Packed fingerprints from the worker (bytes, any alignment) → Uint32Array. */
function toWords(bytes) {
  if (!bytes || !bytes.byteLength || bytes.byteLength % (FRAME_WORDS * 4)) return null
  const words = new Uint32Array(bytes.byteLength / 4)
  new Uint8Array(words.buffer).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  return words
}

// ---------- binary sidecar ----------
//
// 'LVFP' | uint32 version | uint32 count, then per video:
//   uint16 id bytes | id (UTF-8) | float64 mtime | float64 size | float32 duration |
//   uint16 width | uint16 height | uint8 flags | uint8 summary frames | uint16 dense frames |
//   summary × 16 bytes | dense × 16 bytes        (fingerprints as little-endian uint32 words)

function encode(records) {
  const entries = [...records]
  let size = HEADER
  const ids = entries.map(([id]) => Buffer.from(id, 'utf8'))
  entries.forEach(([, r], i) => (size += 2 + ids[i].length + 30 + ((r.s?.length ?? 0) + (r.x?.length ?? 0)) * 4))
  const buf = Buffer.alloc(size)
  buf.write(MAGIC, 0, 'latin1')
  buf.writeUInt32LE(VERSION, 4)
  buf.writeUInt32LE(entries.length, 8)
  let o = HEADER
  entries.forEach(([, r], i) => {
    buf.writeUInt16LE(ids[i].length, o)
    ids[i].copy(buf, o + 2)
    o += 2 + ids[i].length
    buf.writeDoubleLE(r.m, o)
    buf.writeDoubleLE(r.z, o + 8)
    buf.writeFloatLE(r.d || 0, o + 16)
    buf.writeUInt16LE(Math.min(65535, r.w || 0), o + 20)
    buf.writeUInt16LE(Math.min(65535, r.h || 0), o + 22)
    buf.writeUInt8((r.s ? FLAG_SUMMARY : 0) | (r.f ? FLAG_FAILED : 0), o + 24)
    buf.writeUInt8(r.s ? r.s.length / FRAME_WORDS : 0, o + 25)
    buf.writeUInt16LE(r.x ? r.x.length / FRAME_WORDS : 0, o + 26)
    o += 28
    for (const words of [r.s, r.x]) {
      if (!words) continue
      Buffer.from(words.buffer, words.byteOffset, words.byteLength).copy(buf, o)
      o += words.byteLength
    }
  })
  return buf.subarray(0, o)
}

function decode(buf) {
  const records = new Map()
  if (buf.length < HEADER || buf.toString('latin1', 0, 4) !== MAGIC || buf.readUInt32LE(4) !== VERSION) return records
  const count = buf.readUInt32LE(8)
  let o = HEADER
  const words = (frames) => {
    if (!frames) return null
    const bytes = frames * FRAME_WORDS * 4
    const out = toWords(buf.subarray(o, o + bytes))
    o += bytes
    return out
  }
  for (let i = 0; i < count && o + 2 <= buf.length; i++) {
    const idLength = buf.readUInt16LE(o)
    const id = buf.toString('utf8', o + 2, o + 2 + idLength)
    o += 2 + idLength
    if (o + 28 > buf.length) break
    const r = { m: buf.readDoubleLE(o), z: buf.readDoubleLE(o + 8), d: buf.readFloatLE(o + 16), w: buf.readUInt16LE(o + 20), h: buf.readUInt16LE(o + 22) }
    const flags = buf.readUInt8(o + 24)
    const summary = buf.readUInt8(o + 25)
    const dense = buf.readUInt16LE(o + 26)
    o += 28
    if (o + (summary + dense) * FRAME_WORDS * 4 > buf.length) break
    const summaryWords = words(summary)
    r.s = flags & FLAG_SUMMARY ? summaryWords : null
    r.x = words(dense)
    r.f = flags & FLAG_FAILED ? 1 : 0
    records.set(id, r)
  }
  return records
}

// ---------- matching ----------

const frameDistance = (a, ai, b, bi) => {
  const i = ai * 4
  const j = bi * 4
  return sig.popcount(a[i] ^ b[j]) + sig.popcount(a[i + 1] ^ b[j + 1]) + sig.popcount(a[i + 2] ^ b[j + 2]) + sig.popcount(a[i + 3] ^ b[j + 3])
}

/**
 * Where `shorter` starts inside `longer`, in dense frames (= seconds). alignRobust's offset, then
 * refined to the exact neighbour that fits best: the robust median tolerates being a frame off,
 * so on its own it tends to land a second early.
 */
function alignOffset(longer, shorter) {
  const { offset } = sig.alignRobust(longer, shorter)
  const L = longer.length / 4
  const S = shorter.length / 4
  let best = offset
  let bestTotal = Infinity
  for (let o = Math.max(0, offset - 1); o <= Math.min(L - S, offset + 1); o++) {
    let total = 0
    for (let k = 0; k < S; k++) total += frameDistance(longer, o + k, shorter, k)
    if (total < bestTotal) {
      bestTotal = total
      best = o
    }
  }
  return best
}

/** DupeLens' VideosMatch for two videos { d, s, x } (duration, summary and dense frames). */
function videosMatch(a, b, maxDist) {
  if (!a.s || !b.s || !(a.d > 0) || !(b.d > 0)) return false
  if (sameLength(a.d, b.d)) return sig.framesDistance(a.s, b.s) <= maxDist
  const [longer, shorter] = a.d > b.d ? [a, b] : [b, a]
  if (shorter.d < MIN_TRIMMED || !longer.x || !shorter.x) return false
  return sig.alignRobust(longer.x, shorter.x).distance <= trimLimit(maxDist)
}


/**
 * DupeLens' trimmed-clip test, alignRobust(longer, shorter).distance <= limit, answered exactly
 * but much faster: the median at an offset is within the limit as soon as more than half of the
 * clip's frames have a neighbour (±1) within it, and an offset is given up once too many haven't.
 * Each frame pair is compared at most once (memo in `near`: -1 unknown, 0 / 1), no sorting.
 */
function trimMatches(longer, shorter, limit, near) {
  const L = longer.length / 4
  const S = shorter.length / 4
  if (!S || S > L) return false
  const need = (S >> 1) + 1
  if (!near || near.length < L * S) near = new Int8Array(L * S)
  near.fill(-1, 0, L * S)
  const close = (i, k) => {
    const c = i * S + k
    let v = near[c]
    if (v < 0) v = near[c] = frameDistance(longer, i, shorter, k) <= limit ? 1 : 0
    return v
  }
  for (let o = 0; o + S <= L; o++) {
    let good = 0
    for (let k = 0; k < S; k++) {
      const i = o + k
      if (close(i, k) || (i > 0 && close(i - 1, k)) || (i + 1 < L && close(i + 1, k))) {
        if (++good >= need) return true
      } else if (k + 1 - good > S - need) break // too many misses for this offset
    }
  }
  return false
}

// Candidate pruning for trimmed clips: every frame fingerprint is cut into eight 16-bit chunks,
// and only videos sharing a few chunk values (some frame of one looks a lot like some frame of
// the other) are lined up. Chunk values found in many videos (flat frames, common scenes) are
// ignored, and the bar rises with the videos' lengths, as long videos share more by chance.
const CHUNKS = 8
const KEYS = CHUNKS << 16
const MIN_VOTES = 3
const STOP_SHARE = 0.02 // chunk values found in more than 2 % of videos say nothing

/** Distinct chunk keys of a frame sequence (flat 0x0000 / 0xffff halves skipped), sorted. */
function chunkKeys(x) {
  const keys = new Int32Array(x.length * 2)
  let n = 0
  for (let w = 0; w < x.length; w++) {
    const c = (w & 3) * 2
    const hi = x[w] >>> 16
    const lo = x[w] & 0xffff
    if (hi !== 0 && hi !== 0xffff) keys[n++] = (c << 16) | hi
    if (lo !== 0 && lo !== 0xffff) keys[n++] = ((c + 1) << 16) | lo
  }
  const sorted = keys.subarray(0, n).sort()
  let u = 0
  for (let i = 0; i < n; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[u++] = sorted[i]
  return sorted.slice(0, u)
}

/**
 * All matching pairs among `videos` ([{ d, s, x }]: duration in seconds, summary and dense frame
 * fingerprints), as DupeLens' VideosMatch decides, without comparing every pair:
 *  - same length: only videos whose durations are within the tolerance are compared (sorted);
 *  - trimmed:     only pairs sharing enough distinct 16-bit chunk values are lined up.
 * Returns { pairs: [i, j][], stats }.
 */
function findVideoPairs(videos, maxDist) {
  const started = performance.now()
  const pairs = []
  const ok = videos.map((v) => !!(v && v.s && v.d > 0))
  const order = videos.map((_, i) => i).filter((i) => ok[i]).sort((a, b) => videos[a].d - videos[b].d)
  const stats = { videos: order.length, sameCompared: 0, trimCandidates: 0, trimFramePairs: 0, ms: 0, msSame: 0, msIndex: 0, msTrim: 0 }

  // 1. same length
  for (let p = 0; p < order.length; p++) {
    const a = videos[order[p]]
    for (let q = p + 1; q < order.length; q++) {
      const b = videos[order[q]]
      if (!sameLength(a.d, b.d)) break
      stats.sameCompared++
      if (sig.framesDistance(a.s, b.s) <= maxDist) pairs.push([order[p], order[q]])
    }
  }

  stats.msSame = Math.round(performance.now() - started)

  // 2. trimmed clips: inverted index of chunk values → videos holding them
  const dense = order.filter((i) => videos[i].x)
  const n = dense.length
  if (n > 1) {
    const keys = dense.map((i) => chunkKeys(videos[i].x))
    const counts = new Int32Array(KEYS + 1)
    for (const list of keys) for (const k of list) counts[k + 1]++
    const stop = Math.max(16, Math.ceil(n * STOP_SHARE))
    for (let k = 0; k < KEYS; k++) {
      if (counts[k + 1] > stop) counts[k + 1] = 0 // too common to tell videos apart
      counts[k + 1] += counts[k]
    }
    const postings = new Int32Array(counts[KEYS])
    const fill = counts.slice(0, KEYS)
    keys.forEach((list, v) => {
      for (const k of list) if (counts[k + 1] - counts[k] > 0 && fill[k] < counts[k + 1]) postings[fill[k]++] = v
    })
    stats.msIndex = Math.round(performance.now() - started)

    // shared chunk values per pair, one video at a time (dense counter, no hash map)
    const shared = new Int32Array(n)
    const touched = new Int32Array(n)
    let near = new Int8Array(64 * 1024)
    const minVotes = (a, b) => {
      // what unrelated videos share by chance grows with their lengths
      const chance = (keys[a].length * keys[b].length) / KEYS
      return Math.max(MIN_VOTES, Math.ceil(3 * chance + 2))
    }
    for (let a = 0; a < n; a++) {
      const va = videos[dense[a]]
      let t = 0
      for (const k of keys[a]) {
        for (let p = counts[k]; p < counts[k + 1]; p++) {
          const b = postings[p]
          if (b <= a) continue
          if (shared[b]++ === 0) touched[t++] = b
        }
      }
      for (let q = 0; q < t; q++) {
        const b = touched[q]
        const votes = shared[b]
        shared[b] = 0
        const vb = videos[dense[b]]
        if (sameLength(va.d, vb.d) || Math.min(va.d, vb.d) < MIN_TRIMMED || votes < minVotes(a, b)) continue
        stats.trimCandidates++
        const [longer, shorter] = va.d > vb.d ? [va, vb] : [vb, va]
        const L = longer.x.length / 4
        const S = shorter.x.length / 4
        if (near.length < L * S) near = new Int8Array(L * S)
        stats.trimFramePairs += L * S
        const t = performance.now()
        const hit = trimMatches(longer.x, shorter.x, trimLimit(maxDist), near)
        stats.msTrim += performance.now() - t
        if (hit) pairs.push(va.d > vb.d ? [dense[a], dense[b]] : [dense[b], dense[a]])
      }
    }
  }
  stats.msTrim = Math.round(stats.msTrim)
  stats.ms = Math.round(performance.now() - started)
  return { pairs, stats }
}

/**
 * findVideoPairs on a worker thread, so a big library never blocks the main process. The worker
 * runs this file's own source (and signature.cjs) with `eval`, which also works inside app.asar.
 */
function findVideoPairsAsync(videos, maxDist) {
  let source
  try {
    const load = (file) => JSON.stringify(fs.readFileSync(path.join(__dirname, file), 'utf8'))
    source = `
const { parentPort } = require('node:worker_threads')
const load = (src, req) => {
  const module = { exports: {} }
  new Function('module', 'exports', 'require', '__filename', '__dirname', src)(module, module.exports, req, '', '')
  return module.exports
}
const sig = load(${load('signature.cjs')}, require)
const vf = load(${load('video-frames.cjs')}, (name) => (name === './signature.cjs' ? sig : require(name)))
parentPort.once('message', ({ videos, maxDist }) => parentPort.postMessage(vf.findVideoPairs(videos, maxDist)))`
  } catch {
    return Promise.resolve(findVideoPairs(videos, maxDist))
  }
  return new Promise((resolve) => {
    const worker = new Worker(source, { eval: true })
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      worker.terminate()
      resolve(result)
    }
    worker.once('message', done)
    worker.once('error', (err) => {
      console.error('[video-frames] matching worker failed', err)
      done(findVideoPairs(videos, maxDist))
    })
    worker.postMessage({ videos, maxDist })
  })
}

// ---------- background analysis ----------

class VideoFrames extends EventEmitter {
  /**
   * @param {string} file  the sidecar (userData/video-frames.bin)
   * @param {{ canRun(): boolean, analyze(item, { signal, onProgress }): Promise<object | null> }} options
   *   canRun: false while previews are being made; analyze: Thumbnails.videoFrames
   */
  constructor(file, { canRun, analyze }) {
    super()
    this.file = file
    this.canRun = canRun
    this.analyze = analyze
    this.records = new Map() // id -> { m, z, d, w, h, s, x, f }
    this.videos = [] // library videos
    this.byId = new Map()
    this.running = false
    this.disposed = false
    this.controller = null
    this.progress = { running: false, done: 0, total: 0, current: null }
    this.timers = {}
    this.fresh = 0 // analysed since the last 'changed'
  }

  async load() {
    try {
      this.records = decode(await fsp.readFile(this.file))
    } catch {}
  }

  saveSoon(ms = SAVE_MS) {
    if (this.timers.save || this.disposed) return
    this.timers.save = setTimeout(() => this.save(), ms)
  }

  async save() {
    clearTimeout(this.timers.save)
    this.timers.save = null
    try {
      const tmp = `${this.file}.tmp`
      await fsp.writeFile(tmp, encode(this.records))
      await fsp.rename(tmp, this.file)
    } catch (err) {
      console.error('Failed to save video fingerprints', err)
    }
  }

  saveNow() {
    if (!this.timers.save) return
    clearTimeout(this.timers.save)
    this.timers.save = null
    try {
      fs.writeFileSync(this.file, encode(this.records))
    } catch {}
  }

  /** The analysis of `item`, if it's current: { d, w, h, s, x, f } (s/x null when it failed). */
  get(item) {
    const r = this.records.get(item.id)
    return r && r.m === item.mtime && r.z === item.size ? r : undefined
  }

  /** Not analysed yet (queued or running). */
  pending(item) {
    return item.type === 'video' && !this.get(item)
  }

  /** Called whenever the library changes: forgets removed / changed videos. Doesn't start work. */
  sync(items) {
    this.videos = items.filter((it) => it.type === 'video')
    this.byId = new Map(this.videos.map((it) => [it.id, it]))
    let removed = false
    for (const [id, r] of this.records) {
      const it = this.byId.get(id)
      if (!it || it.mtime !== r.m || it.size !== r.z) {
        this.records.delete(id)
        removed = true
      }
    }
    if (removed) this.saveSoon()
    this.setProgress()
  }

  /** Starts (or resumes) the analysis if there is something to do and previews are done. */
  pump() {
    if (this.disposed || this.running || !this.canRun()) return
    if (!this.videos.some((it) => !this.get(it))) return
    this.run().catch((err) => console.error('[video-frames] analysis failed', err))
  }

  /**
   * What to read first: videos that have a same-length partner (likely copies), then small
   * files before big ones, so most results arrive early.
   */
  queue() {
    const todo = this.videos.filter((it) => !this.get(it))
    const known = this.videos.filter((it) => it.duration > 0).sort((a, b) => a.duration - b.duration)
    const paired = new Set()
    for (let i = 0; i + 1 < known.length; i++) {
      if (sameLength(known[i].duration, known[i + 1].duration)) {
        paired.add(known[i].id)
        paired.add(known[i + 1].id)
      }
    }
    return todo.sort((a, b) => Number(paired.has(b.id)) - Number(paired.has(a.id)) || a.size - b.size)
  }

  setProgress(current = null) {
    const total = this.videos.length
    let done = 0
    for (const it of this.videos) if (this.get(it)) done++
    this.progress = { running: this.running, done, total, current }
    if (this.timers.progress) return
    this.timers.progress = setTimeout(() => {
      this.timers.progress = null
      this.emit('progress', this.progress)
    }, 500)
  }

  changedSoon(force) {
    if (!this.fresh) return
    if (!force && this.timers.changed) return
    clearTimeout(this.timers.changed)
    this.timers.changed = setTimeout(
      () => {
        this.timers.changed = null
        this.fresh = 0
        if (!this.disposed) this.emit('changed')
      },
      force ? 0 : CHANGED_MS,
    )
  }

  async run() {
    this.running = true
    this.controller = new AbortController()
    const { signal } = this.controller
    let failures = []
    try {
      const todo = this.queue()
      let next = 0
      const worker = async () => {
        while (next < todo.length && !this.disposed && !signal.aborted) {
          if (!this.canRun()) return // previews first; pump() resumes later
          const item = this.byId.get(todo[next++].id) // the library may have changed meanwhile
          if (!item || this.get(item)) continue
          this.setProgress(item.id)
          const res = await this.analyze(item, { signal })
          if (this.disposed || signal.aborted) return
          const r = { m: item.mtime, z: item.size, d: 0, w: 0, h: 0, s: null, x: null, f: 1 }
          if (res && res.duration > 0) {
            Object.assign(r, { d: res.duration, w: res.width || 0, h: res.height || 0, s: toWords(res.summary), x: toWords(res.dense) })
            if (r.s && r.s.length !== SUMMARY_FRAMES * FRAME_WORDS) r.s = null
            // without all summary frames the video is only checked for exact copies (as DupeLens)
            if (!r.s) r.x = null
            r.f = r.s ? 0 : 1
          }
          this.records.set(item.id, r)
          if (r.f) {
            failures.push(item.id)
            if (failures.length >= FAILURES_IN_A_ROW) {
              // Probably not these videos but the worker: forget the failures and retry later.
              for (const id of failures) this.records.delete(id)
              console.error('[video-frames] several videos in a row failed; pausing')
              return
            }
          } else failures = []
          this.fresh++
          this.setProgress(item.id)
          this.saveSoon()
          this.changedSoon(false)
          await new Promise((resolve) => setTimeout(resolve, GAP_MS))
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    } finally {
      this.running = false
      this.controller = null
      this.setProgress()
      if (!this.disposed) {
        this.changedSoon(true)
        this.saveSoon(1000)
      }
    }
  }

  /** Stops the current analysis (it resumes on the next pump()). */
  cancel() {
    this.controller?.abort()
  }

  progressInfo() {
    return this.progress
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.controller?.abort()
    clearTimeout(this.timers.changed)
    clearTimeout(this.timers.progress)
    this.saveNow()
  }
}

module.exports = {
  VideoFrames,
  findVideoPairs,
  findVideoPairsAsync,
  videosMatch,
  alignOffset,
  sameLength,
  trimLimit,
  toWords,
  chunkKeys,
  encode,
  decode,
  DENSE_INTERVAL,
  SUMMARY_FRAMES,
}
