const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const sharp = require('sharp')

/**
 * Magic eraser: brush over something and it is replaced by plausible background (LaMa inpainting,
 * run by eraser-engine.cjs in its own process).
 *
 * In an edit recipe the erasing is a list of steps, one per press of "Erase":
 *   erase: [{ strokes: [{ size, points }] }]
 *     points  x0, y0, x1, y1, … as fractions of the width and height of the upright photo (after its
 *             EXIF orientation, before any turn, flip, straighten or crop)
 *     size    brush diameter, as a fraction of the photo's long side
 * Steps run first, before the turns and colours (see editor.cjs), so the brushed area stays on the
 * object whatever else is changed later, and moving a slider never runs the model again.
 *
 * Each step's strokes are grouped into regions (a square around the strokes with room for context;
 * strokes whose squares overlap share one). A region is filled at the model's 512×512 and blended
 * back in. Model outputs are cached per (photo, steps so far, region) and reused at any resolution
 * when they were made from at least as much detail: "Erase" fills at full size, so the preview and
 * the saved copy reuse that result and show the same fill.
 */

const MODEL = path.join('lama', 'lama.onnx')
const CONTEXT = 2.5 // region side ÷ brushed size
const MIN_SIDE = 0.12 // smallest region side, as a fraction of the photo's long side
const FEATHER = 0.004 // soft edge outside the brush, as a fraction of the long side
const MAX_STEPS = 64
const MAX_STROKES = 256
const MAX_POINTS = 8000 // numbers per stroke (x, y pairs)
const OUT_CACHE = 48 // model outputs kept (768 KB each)
const BASE_BUDGET = 300 * 1024 * 1024 // erased pictures kept (the latest is always kept)
const IDLE_STOP = 3 * 60_000 // engine stops this long after the editor closes

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/** Recipe steps from the renderer → safe, compact steps (unusable strokes and empty steps dropped). */
function cleanSteps(list) {
  if (!Array.isArray(list)) return []
  const steps = []
  for (const step of list.slice(0, MAX_STEPS)) {
    const strokes = []
    for (const s of Array.isArray(step?.strokes) ? step.strokes.slice(0, MAX_STROKES) : []) {
      if (!finite(s?.size) || !Array.isArray(s.points)) continue
      const pts = s.points.slice(0, MAX_POINTS)
      if (pts.length < 2 || pts.length % 2 || !pts.every(finite)) continue
      strokes.push({
        size: Math.min(0.5, Math.max(0.0005, s.size)),
        points: pts.map((v) => Math.min(1.5, Math.max(-0.5, v))),
      })
    }
    if (strokes.length) steps.push({ strokes })
  }
  return steps
}

/**
 * Strokes in some picture's coordinates → a recipe step. `map(x, y)` turns a point (fractions of
 * that picture) into fractions of the upright photo; `scale` turns a brush size (fraction of that
 * picture's long side) into a fraction of the photo's long side. Points closer together than a
 * third of the brush radius add nothing and are dropped.
 */
function makeStep(strokes, map, scale, W, H) {
  const L = Math.max(W, H)
  const out = []
  for (const s of Array.isArray(strokes) ? strokes : []) {
    if (!finite(s?.size) || !Array.isArray(s.points) || s.points.length < 2) continue
    const size = Math.min(0.5, Math.max(0.0005, s.size * scale))
    const gap = (size * L) / 6
    const points = []
    let lx = NaN
    let ly = NaN
    const n = s.points.length >> 1
    for (let i = 0; i < n; i++) {
      if (!finite(s.points[2 * i]) || !finite(s.points[2 * i + 1])) continue
      const [u, v] = map(s.points[2 * i], s.points[2 * i + 1])
      const px = u * W
      const py = v * H
      if (i < n - 1 && points.length && Math.hypot(px - lx, py - ly) < gap) continue
      points.push(Math.round(u * 1e5) / 1e5, Math.round(v * 1e5) / 1e5)
      lx = px
      ly = py
    }
    if (points.length) out.push({ size: Math.round(size * 1e5) / 1e5, points })
  }
  return cleanSteps([{ strokes: out }])[0] ?? null
}

/**
 * The regions one step touches in a W×H picture: [{ x, y, w, h, strokes: [{ r, pts }] }] with the
 * strokes in the region's own pixels. Sizes are proportional to the picture, so a region covers
 * the same part of the photo at any resolution.
 */
function regionsOf(step, W, H) {
  const L = Math.max(W, H)
  const feather = FEATHER * L
  const groups = step.strokes.map((s) => {
    const r = (s.size * L) / 2
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i < s.points.length; i += 2) {
      const x = s.points[i] * W
      const y = s.points[i + 1] * H
      x0 = Math.min(x0, x - r)
      y0 = Math.min(y0, y - r)
      x1 = Math.max(x1, x + r)
      y1 = Math.max(y1, y + r)
    }
    return { strokes: [s], box: [x0 - feather, y0 - feather, x1 + feather, y1 + feather] }
  })
  const square = ([x0, y0, x1, y1]) => {
    const side = Math.max((x1 - x0) * CONTEXT, (y1 - y0) * CONTEXT, MIN_SIDE * L)
    const fit = (lo, hi, size) => {
      const s = Math.min(side, size)
      const start = Math.min(size - s, Math.max(0, (lo + hi) / 2 - s / 2))
      return [Math.round(start), Math.round(start + s)]
    }
    const [ax, bx] = fit(x0, x1, W)
    const [ay, by] = fit(y0, y1, H)
    return { x: ax, y: ay, w: Math.max(1, bx - ax), h: Math.max(1, by - ay) }
  }
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  // merge strokes whose regions overlap, until nothing changes
  let merged = true
  while (merged) {
    merged = false
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length && !merged; j++) {
        if (!overlap(square(groups[i].box), square(groups[j].box))) continue
        const a = groups[i].box
        const b = groups[j].box
        groups[i] = {
          strokes: [...groups[i].strokes, ...groups[j].strokes],
          box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])],
        }
        groups.splice(j, 1)
        merged = true
      }
    }
  }
  return groups.map((g) => {
    const reg = square(g.box)
    reg.feather = feather
    reg.strokes = g.strokes.map((s) => {
      const pts = new Float32Array(s.points.length)
      for (let i = 0; i < s.points.length; i += 2) {
        pts[i] = s.points[i] * W - reg.x
        pts[i + 1] = s.points[i + 1] * H - reg.y
      }
      return { r: (s.size * L) / 2, pts }
    })
    return reg
  })
}

/** The engine process (eraser-engine.cjs). Restarted automatically if it dies. */
class EraserEngine {
  constructor({ modelsDir, adapterFile, hintFile, device }) {
    this.modelsDir = modelsDir
    this.adapterFile = adapterFile
    this.hintFile = hintFile
    this.force = device ?? process.env.LUMEN_ERASER_DEVICE // 'cpu' or an adapter number, for testing
    this.child = null
    this.ready = null
    this.info = null
    this.error = null
    this.seq = 0
    this.pending = new Map()
  }

  fork() {
    const file = path.join(__dirname, 'eraser-engine.cjs')
    let electron = null
    try {
      electron = require('electron')
    } catch {}
    if (electron?.utilityProcess) return electron.utilityProcess.fork(file, [], { serviceName: 'Lumen magic eraser', stdio: 'ignore' })
    // plain Node (tests)
    const child = require('node:child_process').fork(file, [], { serialization: 'advanced', stdio: 'inherit' })
    child.postMessage = (msg) => child.send(msg)
    return child
  }

  start() {
    if (this.closed) return Promise.reject(new Error('The app is closing'))
    if (this.child) return this.ready
    const child = this.fork()
    this.child = child
    this.error = null
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The magic eraser did not start')), 180_000)
      child.on('exit', () => reject(new Error('The magic eraser stopped while loading'))) // no-op once ready
      child.on('message', (msg) => {
        if (msg.type === 'ready') {
          clearTimeout(timer)
          if (msg.error) return reject(new Error(msg.error))
          this.info = msg
          console.log(`[eraser] engine ready on ${msg.device}${msg.adapter ?? ''} in ${msg.loadMs} ms`, JSON.stringify(msg.timings))
          resolve(msg)
        } else if (msg.type === 'result') {
          const job = this.pending.get(msg.seq)
          if (!job) return
          this.pending.delete(msg.seq)
          clearTimeout(job.timer)
          job.resolve(msg)
        }
      })
    })
    this.ready.catch((err) => {
      this.error = err.message
      console.error(`[eraser] engine failed to start: ${err.message}`)
      if (this.child === child) {
        this.child = null
        child.kill()
      }
    })
    child.on('exit', () => {
      for (const [seq, job] of this.pending) {
        this.pending.delete(seq)
        clearTimeout(job.timer)
        job.resolve(null)
      }
      if (this.child === child) {
        this.child = null
        this.info = null
      }
    })
    const f = String(this.force ?? '')
    const force = f === 'cpu' ? 'cpu' : /^\d+$/.test(f) ? Number(f) : undefined
    child.postMessage({ type: 'init', modelsDir: this.modelsDir, cacheFile: this.adapterFile, hintFile: this.hintFile, force })
    return this.ready
  }

  /** One region → { ok, data, out, ms, inferMs, device }; throws if the engine can't run. */
  async run(msg) {
    await this.start()
    const child = this.child
    if (!child) throw new Error('The magic eraser stopped')
    const res = await new Promise((resolve) => {
      const seq = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        resolve({ ok: false, error: 'The magic eraser took too long' })
      }, 180_000)
      this.pending.set(seq, { resolve, timer })
      child.postMessage({ ...msg, type: 'erase', seq })
    })
    if (!res) throw new Error('The magic eraser stopped')
    if (!res.ok) throw new Error(res.error || 'The magic eraser failed')
    return res
  }

  stop() {
    this.child?.kill()
    this.child = null
    this.info = null
  }

  dispose() {
    this.closed = true
    this.stop()
  }
}

const hash = (s) => createHash('sha1').update(s).digest('hex')

/** Copies a w×h block out of / into a raw RGB picture. */
function cut(img, r) {
  const { width: W } = img.info
  const out = Buffer.alloc(r.w * r.h * 3)
  for (let y = 0; y < r.h; y++) img.data.copy(out, y * r.w * 3, ((r.y + y) * W + r.x) * 3, ((r.y + y) * W + r.x + r.w) * 3)
  return out
}
function paste(data, W, r, block) {
  const b = Buffer.from(block.buffer, block.byteOffset, block.byteLength)
  for (let y = 0; y < r.h; y++) b.copy(data, ((r.y + y) * W + r.x) * 3, y * r.w * 3, (y + 1) * r.w * 3)
}

class Eraser {
  constructor({ modelsDir, adapterFile, hintFile, device } = {}) {
    this.modelsDir = modelsDir
    this.engine = new EraserEngine({ modelsDir, adapterFile, hintFile, device })
    this.outs = new Map() // hash(photo, steps so far, region) -> { data, iw, ih, side }
    this.bases = new Map() // photo + size + steps so far -> { data, info } (insertion order = age)
    this.baseBytes = 0
    this.inflight = new Map()
    this.idle = null
    this.last = null // timings of the latest step
  }

  get available() {
    return fs.existsSync(path.join(this.modelsDir, MODEL))
  }

  /** { available, ready, device, error }. `warm` starts the engine (loading takes a few seconds). */
  status(warm = false) {
    if (warm && this.available && !this.engine.closed) {
      clearTimeout(this.idle)
      this.engine.start().catch(() => {})
    }
    const info = this.engine.info
    return {
      available: this.available,
      ready: !!info && !!this.engine.child,
      device: info ? info.device : null,
      error: this.engine.error ?? undefined,
    }
  }

  /**
   * Applies erase `steps` to `img` ({ data, info }: the upright photo as raw pixels, at any size).
   * `key` names the photo (id + modified time) for the caches. Resolves to { data, info } (RGB).
   */
  async apply(img, steps, key) {
    if (!steps.length) return img
    if (!this.available) throw new Error("The magic eraser isn't installed")
    clearTimeout(this.idle)
    const { width: W, height: H } = img.info
    const baseKey = (k) => `${key}|${W}x${H}|${hash(JSON.stringify(steps.slice(0, k)))}`
    let k = steps.length
    let cur = null
    for (; k > 0; k--) {
      cur = this.bases.get(baseKey(k))
      if (cur) break
    }
    if (!cur) cur = await rgb(img)
    for (; k < steps.length; k++) {
      const name = baseKey(k + 1)
      let job = this.inflight.get(name)
      if (!job) {
        job = this.step(cur, steps, k, key).finally(() => this.inflight.delete(name))
        this.inflight.set(name, job)
      }
      cur = await job
      this.remember(name, cur)
    }
    return cur
  }

  /** Runs step k on `cur` (the picture after steps 0…k−1). */
  async step(cur, steps, k, key) {
    const { width: W, height: H } = cur.info
    const prefix = JSON.stringify(steps.slice(0, k + 1))
    const data = Buffer.from(cur.data)
    const timing = { regions: 0, inferred: 0, ms: 0, inferMs: 0, device: null }
    const started = performance.now()
    const regions = regionsOf(steps[k], W, H)
    for (let j = 0; j < regions.length; j++) {
      const reg = regions[j]
      const id = hash(`${key}|${prefix}|${j}`)
      const side = Math.max(reg.w, reg.h)
      const known = this.outs.get(id)
      // a result made from at least as much detail as this picture has (up to the model's 512)
      const reuse = known && known.side >= 0.9 * Math.min(512, side) ? known : null
      const res = await this.engine.run({
        width: reg.w,
        height: reg.h,
        image: cut(cur, reg),
        strokes: reg.strokes,
        feather: reg.feather,
        cached: reuse ? { data: reuse.data, iw: reuse.iw, ih: reuse.ih } : undefined,
      })
      if (!reuse) {
        this.outs.delete(id)
        this.outs.set(id, { ...res.out, side: Math.min(512, side) })
        while (this.outs.size > OUT_CACHE) this.outs.delete(this.outs.keys().next().value)
        timing.inferred++
        timing.inferMs += res.inferMs
      }
      timing.device = res.device
      paste(data, W, reg, res.data)
      timing.regions++
    }
    timing.ms = Math.round(performance.now() - started)
    this.last = timing
    return { data, info: { width: W, height: H, channels: 3 } }
  }

  remember(name, img) {
    if (this.bases.has(name)) return
    this.bases.set(name, img)
    this.baseBytes += img.data.length
    for (const [k, v] of this.bases) {
      if (this.baseBytes <= BASE_BUDGET || this.bases.size <= 1) break
      this.bases.delete(k)
      this.baseBytes -= v.data.length
    }
  }

  /** Forgets the cached pictures (the editor closed); the engine stops a little later. */
  release() {
    this.bases.clear()
    this.baseBytes = 0
    this.outs.clear()
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.engine.stop(), IDLE_STOP)
    this.idle.unref?.()
  }

  dispose() {
    clearTimeout(this.idle)
    this.engine.dispose()
    this.bases.clear()
    this.outs.clear()
  }
}

/** Raw pixels as 3-channel RGB (grey pictures are expanded). */
async function rgb(img) {
  if (img.info.channels === 3) return img
  const { width, height, channels } = img.info
  const { data, info } = await sharp(img.data, { raw: { width, height, channels } })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels === 3) return { data, info }
  const out = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = data[i * info.channels]
  return { data: out, info: { width, height, channels: 3 } }
}

module.exports = { Eraser, cleanSteps, makeStep, regionsOf }
