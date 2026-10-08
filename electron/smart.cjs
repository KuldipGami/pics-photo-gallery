const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { utilityProcess } = require('electron')
const { writeAtomic, writeAtomicSync, serial, keepAside } = require('./safe-file.cjs')

const MODEL = 'siglip-base-patch16-224'
const DIMS = 768
const CONCURRENCY = 4 // photos in flight (decoding overlaps with GPU inference)
const MAGIC = 'LSM1'
// SigLIP's learned calibration turns a similarity into a match probability:
// p = sigmoid(SCALE * cos + BIAS) (read from Google's checkpoint, see scripts/get-models.mjs).
const SCALE = 117.33
const BIAS = -12.93
const MIN_PROB = 0.002 // ≈ cos 0.057: clearly related, recall over precision
const BEST_MARGIN = 0.06 // ...and not far below the best match for this search
const MAX_RESULTS = 3000
const SIMILAR_MIN = 0.6 // image-to-image cosine: same kind of scene or subject
const SIMILAR_MAX = 400
const MAX_ATTEMPTS = 2 // an item the engine keeps dying or stalling on is left for the next session
const MAX_FAILURES = 4 // engine crashes / stalls in a row (no good answer between): stop for the session

const prob = (cos) => 1 / (1 + Math.exp(-(SCALE * cos + BIAS)))

/**
 * The SigLIP engine process (smart-engine.cjs). Restarted automatically if it dies; killed and
 * restarted if it stops answering (a stuck GPU), on the CPU once that has happened twice.
 */
class SmartEngine {
  constructor({ modelsDir, adapterFile, hintFile }) {
    this.modelsDir = modelsDir
    this.adapterFile = adapterFile
    this.hintFile = hintFile
    this.child = null
    this.ready = null
    this.info = null
    this.seq = 0
    this.pending = new Map()
    this.hangs = 0 // times it stopped answering this session
    this.cpu = false
    this.failures = 0 // crashes, stalls and failed runs since its last good answer
  }

  start() {
    if (this.closed) return Promise.reject(new Error('The app is closing'))
    if (this.child) return this.ready
    const child = utilityProcess.fork(path.join(__dirname, 'smart-engine.cjs'), [], {
      serviceName: 'Pics smart search',
      stdio: 'ignore',
    })
    this.child = child
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The search engine did not start')), 120_000)
      child.on('exit', () => {
        clearTimeout(timer)
        reject(new Error('The search engine stopped while loading')) // no-op once ready
      })
      child.on('message', (msg) => {
        if (msg.type === 'ready') {
          clearTimeout(timer)
          if (msg.error) return reject(new Error(msg.error))
          this.info = msg
          console.log(`[smart] engine ready on ${msg.device}${msg.adapter ?? ''}`, JSON.stringify(msg.timings))
          resolve(msg)
        } else if (msg.type === 'device') {
          // the GPU failed mid-session: it carries on on the CPU
          console.error(`[smart] engine moved to the ${msg.device}: ${msg.reason}`)
          if (this.info) this.info = { ...this.info, device: msg.device, adapter: msg.adapter }
        } else if (msg.type === 'result') {
          const job = this.pending.get(msg.seq)
          if (!job) return
          this.pending.delete(msg.seq)
          clearTimeout(job.timer)
          if (msg.ok) this.failures = 0
          job.resolve(msg)
        }
      })
    })
    this.ready.catch((err) => {
      console.error(`[smart] engine failed to start: ${err.message}`)
      // not kept for the session: the next start() tries again with a fresh process
      if (this.child === child) this.stop()
    })
    child.on('exit', () => {
      const lost = this.drop(child, true)
      if (this.child === child) {
        this.child = null
        this.ready = null
        if (lost) this.failures++ // it died while working
      }
    })
    child.postMessage({ type: 'init', modelsDir: this.modelsDir, cacheFile: this.adapterFile, hintFile: this.hintFile, cpu: this.cpu })
    return this.ready
  }

  /**
   * Answers the jobs sent to `child` (it's gone); how many there were. It works on one job at a
   * time, in order: when it died by itself (`crashed`) the oldest job is the likely cause and gets
   * null; the others weren't reached yet and get { retry: true } (try again, nothing counted).
   */
  drop(child, crashed = false) {
    let n = 0
    for (const [seq, job] of this.pending) {
      if (job.child !== child) continue
      this.pending.delete(seq)
      clearTimeout(job.timer)
      job.resolve(crashed && n === 0 ? null : { ok: false, retry: true })
      n++
    }
    return n
  }

  /**
   * { ok, vec } — ok:false for an unreadable image (stage 'decode'), a failed run (stage 'run'), no
   * answer for a minute (timeout: the process is replaced) or the engine gone before it got to this
   * one (retry); null if the engine died on it.
   */
  async run(msg) {
    await this.start()
    const child = this.child
    if (!child) return null
    return new Promise((resolve) => {
      const seq = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        resolve({ ok: false, timeout: true })
        this.hung(child)
      }, 60_000)
      this.pending.set(seq, { resolve, timer, child })
      child.postMessage({ ...msg, seq })
    })
  }

  /** It stopped answering: a fresh process next time (on the CPU after the second time). */
  hung(child) {
    if (this.child !== child) return
    if (++this.hangs >= 2) this.cpu = true
    this.fail()
  }

  /** Something went wrong inside the engine: count it, and start a fresh process next time. */
  fail() {
    this.failures++
    this.stop()
  }

  /** Stops the process without closing (the next run starts a fresh one). */
  stop() {
    const child = this.child
    this.child = null
    this.ready = null
    this.info = null
    if (!child) return
    this.drop(child)
    child.kill()
  }

  dispose() {
    this.closed = true
    this.stop()
  }
}

/**
 * Reads a binary file, waiting a moment while antivirus or the search indexer holds it.
 * { buf } | { missing: true } | { error } (still unreadable: don't save over it this session).
 */
async function readBinary(file) {
  let last = null
  for (const ms of [0, 50, 100, 200, 400, 800, 1500]) {
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms))
    try {
      return { buf: await fsp.readFile(file) }
    } catch (err) {
      if (err?.code === 'ENOENT') return { missing: true }
      last = err
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) break
    }
  }
  return { error: last }
}

/** int8 + scale per vector (4× smaller than float32; error far below what changes a ranking). */
function quantize(v) {
  let max = 0
  for (const x of v) max = Math.max(max, Math.abs(x))
  const scale = max || 1
  const q = new Int8Array(v.length)
  for (let i = 0; i < v.length; i++) q[i] = Math.round((v[i] / scale) * 127)
  return { q, s: scale / 127 }
}

/**
 * "Search by what's in the photo": a SigLIP embedding for every photo and video (from its cached
 * preview), kept in smart.bin. A search embeds the text and ranks every item by similarity.
 */
class SmartIndex extends EventEmitter {
  constructor(file, { canRun, thumb, modelsDir, adapterFile, hintFile }) {
    super()
    this.file = file
    this.canRun = canRun
    this.thumb = thumb // item -> Promise<Buffer | null>
    this.vectors = new Map() // id -> { m: mtime, q: Int8Array(768), s: scale }
    this.media = new Map() // id -> library item
    this.enabled = true
    this.halted = false
    this.error = null
    this.queue = []
    this.active = 0
    this.inflight = new Set()
    this.failed = new Set() // unreadable this session (never saved: tried again next time)
    this.attempts = new Map() // id -> times the engine died or stalled on it (this session)
    this.progress = { done: 0, total: 0 }
    this.engine = new SmartEngine({ modelsDir, adapterFile, hintFile })
    this.queryCache = new Map()
    this.timers = {}
    this.dirty = false // changes not on disk yet
    this.blocked = false // smart.bin couldn't be read: don't save over it this session
    this.writer = serial(async () => {
      const data = this.serialize()
      this.writing = true
      try {
        await writeAtomic(this.file, data)
      } finally {
        this.writing = false
        if (this.flushed) {
          // saveNow() wrote newer vectors while this one was on its way: put those back on top
          this.flushed = false
          try {
            writeAtomicSync(this.file, this.serialize())
          } catch {}
        }
      }
    })
  }

  get available() {
    return fs.existsSync(path.join(this.engine.modelsDir, 'siglip', 'vision_model_fp16.onnx'))
  }

  // ---------- persistence: header JSON + int8 vectors ----------

  async load() {
    const r = await readBinary(this.file)
    if (r.missing) return
    if (r.error) {
      this.blocked = true
      console.error('[smart] smart.bin could not be read; not saving over it this session', r.error)
      return
    }
    const buf = r.buf
    try {
      if (buf.toString('latin1', 0, 4) !== MAGIC) throw new Error('not a search index')
      const headerLen = buf.readUInt32LE(4)
      const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen))
      if (header.model !== MODEL || header.dims !== DIMS) return // made for another model: rebuilt
      if (buf.length < 8 + headerLen + header.ids.length * DIMS) throw new Error('cut short')
      let off = 8 + headerLen
      header.ids.forEach((id, i) => {
        const q = new Int8Array(DIMS)
        q.set(new Int8Array(buf.buffer, buf.byteOffset + off, DIMS))
        off += DIMS
        this.vectors.set(id, { m: header.m[i], q, s: header.s[i] })
      })
    } catch (err) {
      this.vectors.clear()
      const keptAs = keepAside(this.file)
      console.error(`[smart] index damaged (kept as ${keptAs}), rebuilding`, err)
    }
  }

  serialize() {
    const ids = [...this.vectors.keys()]
    const recs = ids.map((id) => this.vectors.get(id))
    const header = Buffer.from(JSON.stringify({ model: MODEL, dims: DIMS, ids, m: recs.map((r) => r.m), s: recs.map((r) => r.s) }))
    const out = Buffer.alloc(8 + header.length + ids.length * DIMS)
    out.write(MAGIC, 0, 'latin1')
    out.writeUInt32LE(header.length, 4)
    header.copy(out, 8)
    let off = 8 + header.length
    for (const r of recs) {
      Buffer.from(r.q.buffer, r.q.byteOffset, DIMS).copy(out, off)
      off += DIMS
    }
    return out
  }

  saveSoon(ms = 20_000) {
    this.dirty = true
    if (this.timers.save) return
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
      console.error('Failed to save search index', err)
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
      console.error('Failed to save search index', err)
    }
    if (this.writing) this.flushed = true
  }

  // ---------- pipeline ----------

  sync(items) {
    this.media = new Map(items.map((it) => [it.id, it]))
    let dropped = false
    for (const [id, r] of this.vectors) {
      const it = this.media.get(id)
      if (!it || it.mtime !== r.m) {
        this.vectors.delete(id)
        dropped = true
      }
    }
    if (dropped) this.saveSoon()
    this.queue = [...this.media.values()]
      .filter((it) => !this.vectors.has(it.id) && !this.inflight.has(it.id) && !this.failed.has(it.id))
      .sort((a, b) => b.date - a.date)
      .map((it) => it.id)
    this.progress = { done: 0, total: this.queue.length }
    this.emitProgress()
    this.pump()
  }

  pump() {
    if (!this.enabled || this.halted || this.disposed || !this.available || !this.canRun()) return
    const busy = [] // put back while still being read: their turn comes once that's over
    while (this.active < CONCURRENCY && this.queue.length) {
      const item = this.media.get(this.queue.shift())
      if (!item || this.vectors.has(item.id)) continue
      if (this.inflight.has(item.id)) {
        busy.push(item.id)
        continue
      }
      this.active++
      this.inflight.add(item.id)
      this.embed(item).finally(() => {
        this.active--
        this.inflight.delete(item.id)
        this.progress.done++
        this.emitProgress()
        this.pump()
      })
    }
    this.queue.push(...busy)
  }

  async embed(item) {
    let res
    // (no preview now is this item's problem, not a reason to stop: see below)
    const data = await Promise.resolve()
      .then(() => this.thumb(item))
      .catch(() => null)
    try {
      res = data ? await this.engine.run({ type: 'image', data }) : { ok: false }
    } catch (err) {
      this.halted = true
      this.error = String(err?.message || err)
      this.queue.unshift(item.id)
      this.progress.done--
      this.emitProgress()
      return
    }
    if (this.disposed || !this.enabled) return // (turned off: the engine was stopped)
    if (res?.retry) {
      // the engine went away before it got to this one
      this.queue.push(item.id)
      this.progress.done--
      return
    }
    if (!res || res.timeout || res.stage === 'run') {
      // The engine went away, stalled or failed to run: it starts afresh and the item is tried
      // again, but not forever when it's the one that keeps doing this.
      if (res?.stage === 'run') this.engine.fail()
      if (this.engine.failures >= MAX_FAILURES && !this.halted) {
        this.halted = true
        this.error = 'its engine keeps failing on this computer (it tries again when Pics restarts)'
        console.error(`[smart] indexing stopped for this session: ${this.error}`)
        this.emitProgress()
      }
      const n = (this.attempts.get(item.id) ?? 0) + 1
      this.attempts.set(item.id, n)
      if (n < MAX_ATTEMPTS) {
        this.queue.push(item.id)
        this.progress.done--
      } else this.failed.add(item.id)
      return
    }
    const now = this.media.get(item.id)
    if (!now) return // left the library meanwhile
    if (now.mtime !== item.mtime) {
      // changed while it was being read: read the new version
      this.queue.push(item.id)
      this.progress.done--
      return
    }
    if (!res.ok) {
      this.failed.add(item.id)
      return
    }
    const { q, s } = quantize(res.vec)
    this.vectors.set(item.id, { m: item.mtime, q, s })
    this.attempts.delete(item.id)
    this.saveSoon()
  }

  async embedQuery(query) {
    const key = query.trim().toLowerCase()
    if (this.queryCache.has(key)) return this.queryCache.get(key)
    // a caption-style prompt and the bare words, averaged: robust for both "dog" and "dog on a beach"
    const runs = await Promise.all([this.engine.run({ type: 'text', text: `a photo of ${key}.` }), this.engine.run({ type: 'text', text: key })])
    if (runs.some((r) => !r?.ok)) return null
    const v = new Float32Array(DIMS)
    let norm = 0
    for (let k = 0; k < DIMS; k++) {
      v[k] = runs[0].vec[k] + runs[1].vec[k]
      norm += v[k] * v[k]
    }
    norm = Math.sqrt(norm) || 1
    for (let k = 0; k < DIMS; k++) v[k] /= norm
    if (this.queryCache.size > 100) this.queryCache.delete(this.queryCache.keys().next().value)
    this.queryCache.set(key, v)
    return v
  }

  /** Items that match the text, best first: { ids, scores (0–1) }. */
  async search(query) {
    if (!this.enabled || !this.available || !query.trim() || !this.vectors.size) return { ids: [], scores: [] }
    let q
    try {
      q = await this.embedQuery(query)
    } catch {
      return { ids: [], scores: [] }
    }
    if (!q) return { ids: [], scores: [] }
    const hits = []
    let top = -1
    for (const [id, r] of this.vectors) {
      if (!this.media.has(id)) continue
      let dot = 0
      const v = r.q
      for (let k = 0; k < DIMS; k++) dot += q[k] * v[k]
      const cos = dot * r.s
      if (cos > top) top = cos
      hits.push([id, cos])
    }
    const floor = Math.max((Math.log(MIN_PROB / (1 - MIN_PROB)) - BIAS) / SCALE, top - BEST_MARGIN)
    const kept = hits.filter((h) => h[1] >= floor).sort((a, b) => b[1] - a[1]).slice(0, MAX_RESULTS)
    return { ids: kept.map((h) => h[0]), scores: kept.map((h) => +prob(h[1]).toFixed(4)) }
  }

  /** Items that look like this one (by their search vectors), most alike first; the item itself leads. */
  similar(id) {
    const a = this.vectors.get(id)
    if (!a || !this.media.has(id)) return { ids: [], scores: [] }
    const hits = []
    for (const [other, r] of this.vectors) {
      if (other === id || !this.media.has(other)) continue
      let dot = 0
      const v = r.q
      for (let k = 0; k < DIMS; k++) dot += a.q[k] * v[k]
      const cos = dot * a.s * r.s
      if (cos >= SIMILAR_MIN) hits.push([other, cos])
    }
    const kept = hits.sort((x, y) => y[1] - x[1]).slice(0, SIMILAR_MAX)
    return { ids: [id, ...kept.map((h) => h[0])], scores: [1, ...kept.map((h) => +h[1].toFixed(4))] }
  }

  /** Whether "Find similar" can work for this item yet. */
  hasVector(id) {
    return this.vectors.has(id)
  }

  setEnabled(enabled) {
    this.enabled = enabled
    if (enabled) {
      this.halted = false
      this.error = null
      this.failed.clear()
      this.attempts.clear()
      this.engine.failures = 0
      this.sync([...this.media.values()])
    } else {
      this.queue = []
      this.progress = { done: 0, total: 0 }
      this.engine.stop() // frees its memory; a fresh one starts when it's turned back on
    }
    this.emitProgress()
  }

  emitProgress() {
    if (this.timers.progress) return
    this.timers.progress = setTimeout(() => {
      this.timers.progress = null
      this.emit('progress', this.progressInfo())
    }, 300)
  }

  progressInfo() {
    return {
      ...this.progress,
      running: this.enabled && !this.halted && this.available && (this.active > 0 || this.queue.length > 0),
      indexed: this.vectors.size,
      available: this.available,
      error: this.error,
      engine: this.engine.info ? { device: this.engine.info.device, adapter: this.engine.info.adapter } : null,
    }
  }

  dispose() {
    this.disposed = true
    this.queue = []
    this.saveNow()
    this.engine.dispose()
  }
}

module.exports = { SmartIndex }
