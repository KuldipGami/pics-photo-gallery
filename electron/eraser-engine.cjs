// Magic eraser engine — runs in its own process (Electron utilityProcess, see eraser.cjs).
//
// LaMa ("big-lama", Apache 2.0) fills a masked hole with plausible background. The model takes a
// fixed 512×512 picture, so each job is one square-ish region of the photo: it is scaled to fit
// 512 (mirrored padding), filled, scaled back and blended in only where the brush went (with a
// short soft edge). Everything outside the brush and its soft edge stays byte-for-byte the same.
// On Windows it runs on the GPU through DirectML (the fastest adapter, as for faces), else on the
// CPU. models/lama/lama.onnx is prepared by scripts/get-models.mjs so DirectML can run it.
const fs = require('node:fs')
const path = require('node:path')
const ort = require('onnxruntime-node')
const sharp = require('sharp')

sharp.cache(false)
ort.env.logLevel = 'error'

const SIZE = 512
const MODEL = path.join('lama', 'lama.onnx')

let session = null
let device = null // { label: 'gpu1' | 'cpu', adapter }
let modelFile = null

async function createSession(providers) {
  return ort.InferenceSession.create(modelFile, { executionProviders: providers, logSeverityLevel: 3, graphOptimizationLevel: 'all' })
}

/** A blank picture with a square hole, for warming up and timing. */
function testFeeds() {
  const mask = new Float32Array(SIZE * SIZE)
  for (let y = 192; y < 320; y++) mask.fill(1, y * SIZE + 192, y * SIZE + 320)
  return {
    image: new ort.Tensor('float32', new Float32Array(3 * SIZE * SIZE).fill(0.5), [1, 3, SIZE, SIZE]),
    mask: new ort.Tensor('float32', mask, [1, 1, SIZE, SIZE]),
  }
}

/** First run (DirectML compiles its shaders then), then the average of `n` more. */
async function timeRuns(s, n) {
  const feeds = testFeeds()
  const out = await s.run(feeds)
  if (!out.output || out.output.data.length !== 3 * SIZE * SIZE) throw new Error('Unexpected model output')
  if (!n) return 0
  const t = performance.now()
  for (let i = 0; i < n; i++) await s.run(feeds)
  return (performance.now() - t) / n
}

const readAdapter = (file) => {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8')).adapter
    return Number.isInteger(a) ? a : null
  } catch {
    return null
  }
}

/** A DirectML session on adapter `id` that has run once: null if there is no such adapter. */
async function tryAdapter(id, timed) {
  let s
  try {
    s = await createSession([{ name: 'dml', deviceId: id }])
  } catch {
    return null
  }
  try {
    return { s, adapter: id, label: `gpu${id}`, ms: await timeRuns(s, timed) }
  } catch {
    s.release?.()
    return { failed: true }
  }
}

/**
 * Loads the model on the fastest GPU. The adapter picked for this engine before, else the one
 * picked for faces, is tried first; otherwise every DirectML adapter is timed. `force` ('cpu' or
 * an adapter number) is for testing.
 */
async function init({ modelsDir, cacheFile, hintFile, force }) {
  modelFile = path.join(modelsDir, MODEL)
  if (!fs.existsSync(modelFile)) throw new Error('The magic eraser model is missing (models/lama/lama.onnx)')
  const started = performance.now()
  const candidates = []
  if (process.platform === 'win32' && force !== 'cpu') {
    const hints = [cacheFile, ...[].concat(hintFile ?? [])] // ours, then other engines' choices
    const known = Number.isInteger(force) ? force : (hints.map(readAdapter).find((a) => a !== null) ?? null)
    let scan = known === null
    if (!scan) {
      const c = await tryAdapter(known, 0)
      if (c && !c.failed) candidates.push(c)
      else scan = !Number.isInteger(force) // adapter gone or can't run it: look at the others
    }
    if (scan) {
      for (let id = 0; id < 4; id++) {
        if (id === known) continue
        const c = await tryAdapter(id, 1)
        if (!c) break // no more adapters
        if (!c.failed) candidates.push(c)
      }
    }
  }
  if (!candidates.length) {
    const s = await createSession(['cpu'])
    await timeRuns(s, 0)
    candidates.push({ s, adapter: null, label: 'cpu', ms: 0 })
  }
  candidates.sort((a, b) => a.ms - b.ms)
  const best = candidates[0]
  for (const c of candidates.slice(1)) c.s.release?.()
  session = best.s
  device = { label: best.label, adapter: best.adapter }
  if (cacheFile && best.adapter !== null && candidates.length > 1) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ adapter: best.adapter }))
    } catch {}
  }
  return {
    device: best.adapter === null ? 'cpu' : 'gpu',
    adapter: best.adapter,
    loadMs: Math.round(performance.now() - started),
    timings: candidates.map((c) => [c.label, Math.round(c.ms * 10) / 10]),
  }
}

/** If the GPU fails mid-session (driver reset, adapter removed), carry on on the CPU. */
async function run(feeds) {
  try {
    return await session.run(feeds)
  } catch (err) {
    if (device.adapter === null) throw err
    console.error('[eraser] GPU run failed, switching to the CPU:', err?.message || err)
    session.release?.()
    session = await createSession(['cpu'])
    device = { label: 'cpu', adapter: null }
    return session.run(feeds)
  }
}

// ---------- one region ----------

/**
 * Distance of every pixel from the brush (≤ 0 inside), up to `reach` past its edge (farther
 * pixels keep +Infinity). Strokes are { r, pts } in this region's pixels; pixel centres are at +0.5.
 */
function brushDistance(W, H, strokes, reach) {
  const dist = new Float32Array(W * H).fill(Infinity)
  for (const { r, pts } of strokes) {
    const far = r + reach + 1
    const count = pts.length >> 1
    for (let k = 0; k < Math.max(1, count - 1); k++) {
      const ax = pts[2 * k]
      const ay = pts[2 * k + 1]
      const bx = count > 1 ? pts[2 * k + 2] : ax
      const by = count > 1 ? pts[2 * k + 3] : ay
      const dx = bx - ax
      const dy = by - ay
      const len2 = dx * dx + dy * dy
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - far))
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + far))
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - far))
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + far))
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5 - ay
        let i = y * W + x0
        for (let x = x0; x <= x1; x++, i++) {
          const px = x + 0.5 - ax
          let t = len2 ? (px * dx + py * dy) / len2 : 0
          t = t < 0 ? 0 : t > 1 ? 1 : t
          const ex = px - t * dx
          const ey = py - t * dy
          const d = Math.sqrt(ex * ex + ey * ey) - r
          if (d < dist[i]) dist[i] = d
        }
      }
    }
  }
  return dist
}

/** Scales a raw picture to w×h and pads it to SIZE×SIZE with a mirror image of itself. */
async function toSquare(data, W, H, channels, w, h, kernel) {
  let img = sharp(data, { raw: { width: W, height: H, channels } }).resize(w, h, { fit: 'fill', kernel })
  if (w < SIZE || h < SIZE) img = img.extend({ right: SIZE - w, bottom: SIZE - h, extendWith: 'mirror' }) // after the resize
  const res = await img.raw().toBuffer({ resolveWithObject: true })
  if (res.info.channels === channels) return res.data
  // padding a one-channel picture comes back as RGB: keep the first channel
  const out = Buffer.alloc(SIZE * SIZE * channels)
  const step = res.info.channels
  for (let i = 0, j = 0; i < out.length; i += channels, j += step) for (let c = 0; c < channels; c++) out[i + c] = res.data[j + c]
  return out
}

/**
 * Fills the brushed part of one region.
 *   image    raw RGB of the region (width × height)
 *   strokes  [{ r, pts }] in the region's pixels
 *   feather  soft edge, in pixels, outside the brush
 *   cached   { data, iw, ih }: a model output from before (same region, same strokes)
 * Resolves to { data (the region with the hole filled), out: { data, iw, ih }, ms, inferMs }.
 */
async function erase({ width: W, height: H, image, strokes, feather, cached }) {
  const started = performance.now()
  const src = Buffer.from(image.buffer, image.byteOffset, image.byteLength)
  const dist = brushDistance(W, H, strokes, feather)
  const n = W * H
  let out = cached
  let inferMs = 0
  if (!out) {
    const scale = SIZE / Math.max(W, H)
    const iw = Math.min(SIZE, Math.max(1, Math.round(W * scale)))
    const ih = Math.min(SIZE, Math.max(1, Math.round(H * scale)))
    // The hole covers the brush and its soft edge, so the blend below only mixes in filled pixels.
    // It is blanked only at 512 (blanking first would smear dark edges into the context), and
    // grown by a pixel there so nothing of what was brushed leaks into the context.
    const hole = Buffer.alloc(n)
    for (let i = 0; i < n; i++) if (dist[i] < feather + 1) hole[i] = 255
    const [rgb, m] = await Promise.all([toSquare(src, W, H, 3, iw, ih, 'lanczos3'), toSquare(hole, W, H, 1, iw, ih, 'linear')])
    const plane = SIZE * SIZE
    const mask = new Float32Array(plane)
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (!m[y * SIZE + x]) continue
        for (let yy = Math.max(0, y - 1); yy <= Math.min(SIZE - 1, y + 1); yy++)
          for (let xx = Math.max(0, x - 1); xx <= Math.min(SIZE - 1, x + 1); xx++) mask[yy * SIZE + xx] = 1
      }
    }
    const img = new Float32Array(3 * plane)
    for (let i = 0; i < plane; i++) {
      if (mask[i]) continue
      img[i] = rgb[i * 3] / 255
      img[plane + i] = rgb[i * 3 + 1] / 255
      img[2 * plane + i] = rgb[i * 3 + 2] / 255
    }
    const t = performance.now()
    const res = await run({ image: new ort.Tensor('float32', img, [1, 3, SIZE, SIZE]), mask: new ort.Tensor('float32', mask, [1, 1, SIZE, SIZE]) })
    inferMs = performance.now() - t
    const o = res.output.data
    const data = Buffer.alloc(3 * plane)
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) {
        const v = o[c * plane + i]
        data[i * 3 + c] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)
      }
    }
    out = { data, iw, ih }
  }
  const fill = await sharp(Buffer.from(out.data.buffer, out.data.byteOffset, out.data.byteLength), { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .extract({ left: 0, top: 0, width: out.iw, height: out.ih })
    .resize(W, H, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer()
  const grain = await grainOf(src, dist, feather, W, H, out.iw, out.ih)
  const data = Buffer.from(src)
  let seed = (W * 73856093) ^ (H * 19349663) ^ 0x2545f491 // the same region gets the same grain
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  let spare = null
  const gauss = () => {
    if (spare !== null) {
      const v = spare
      spare = null
      return v
    }
    const u = Math.max(1e-12, random())
    const m = Math.sqrt(-2 * Math.log(u))
    const t = 2 * Math.PI * random()
    spare = m * Math.sin(t)
    return m * Math.cos(t)
  }
  for (let i = 0; i < n; i++) {
    const d = dist[i]
    if (!(d < feather)) continue
    const a = d <= 0 ? 1 : 1 - d / feather
    const j = i * 3
    const g = grain ? a * gauss() * grain(i % W, (i / W) | 0) : 0
    data[j] = Math.round(a * fill[j] + (1 - a) * src[j] + g)
    data[j + 1] = Math.round(a * fill[j + 1] + (1 - a) * src[j + 1] + g)
    data[j + 2] = Math.round(a * fill[j + 2] + (1 - a) * src[j + 2] + g)
  }
  return { data, out, ms: performance.now() - started, inferMs }
}

/**
 * The fill is made at 512 pixels, so on a bigger region it lacks the photo's fine grain (sensor
 * noise, grass, gravel) and looks smooth. This measures that grain — the region minus its own
 * 512-pixel version — around the hole, per patch on a coarse grid (median-based, so edges don't
 * count), spreads it into the hole and returns grain(x, y): the luminance noise level to add there.
 * Null when the region is barely scaled down.
 */
async function grainOf(src, dist, feather, W, H, iw, ih) {
  if (Math.max(W, H) / SIZE < 1.5) return null
  const raw = { raw: { width: W, height: H, channels: 3 } }
  const small = await sharp(src, raw).resize(iw, ih, { fit: 'fill' }).raw().toBuffer()
  const low = await sharp(small, { raw: { width: iw, height: ih, channels: 3 } }).resize(W, H, { fit: 'fill' }).raw().toBuffer()
  const G = 48
  const gw = Math.max(2, Math.round((G * W) / Math.max(W, H)))
  const gh = Math.max(2, Math.round((G * H) / Math.max(W, H)))
  const BINS = 48
  const hist = new Uint32Array(gw * gh * BINS)
  const count = new Uint32Array(gw * gh)
  const step = W * H > 1_500_000 ? 2 : 1 // a sample is plenty for a median
  for (let y = 0; y < H; y += step) {
    const row = ((y * gh) / H) | 0
    for (let x = 0; x < W; x += step) {
      const i = y * W + x
      if (dist[i] < feather + 1) continue // only around the hole
      const j = i * 3
      const hp = Math.abs(src[j] - low[j] + src[j + 1] - low[j + 1] + src[j + 2] - low[j + 2]) / 3
      const c = row * gw + (((x * gw) / W) | 0)
      hist[c * BINS + Math.min(BINS - 1, Math.round(hp * 2))]++
      count[c]++
    }
  }
  // robust noise level per cell: median |detail| (×1.48 would be σ for pure noise, ×1 is right for
  // regular texture such as grass; 1 errs on the smooth side)
  const level = new Float32Array(gw * gh)
  const weight = new Float32Array(gw * gh)
  for (let c = 0; c < gw * gh; c++) {
    if (count[c] < 24) continue
    let seen = 0
    let b = 0
    while (b < BINS && seen + hist[c * BINS + b] < count[c] / 2) seen += hist[c * BINS + b++]
    level[c] = (b + 0.5) / 2 // bins are half levels
    weight[c] = 1
  }
  if (!weight.some((w) => w)) return null
  // spread into the hole (normalised Gaussian blur on the grid), wider where nothing is near
  const spread = (sigma) => {
    const r = Math.ceil(sigma * 2.5)
    const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)))
    const pass = (v, horizontal) => {
      const o = new Float32Array(v.length)
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          let s = 0
          for (let t = -r; t <= r; t++) {
            const xx = horizontal ? x + t : x
            const yy = horizontal ? y : y + t
            if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue
            s += v[yy * gw + xx] * k[t + r]
          }
          o[y * gw + x] = s
        }
      }
      return o
    }
    const blur = (v) => pass(pass(v, true), false)
    return { num: blur(level.map((l, c) => l * weight[c])), den: blur(weight) }
  }
  const near = spread(2)
  const far = spread(8)
  const grid = new Float32Array(gw * gh)
  for (let c = 0; c < gw * gh; c++) {
    const v = near.den[c] > 0.05 ? near.num[c] / near.den[c] : far.den[c] > 1e-6 ? far.num[c] / far.den[c] : 0
    grid[c] = Math.min(24, v)
  }
  return (x, y) => {
    const gx = Math.min(gw - 1, Math.max(0, ((x + 0.5) * gw) / W - 0.5))
    const gy = Math.min(gh - 1, Math.max(0, ((y + 0.5) * gh) / H - 0.5))
    const x0 = gx | 0
    const y0 = gy | 0
    const x1 = Math.min(gw - 1, x0 + 1)
    const y1 = Math.min(gh - 1, y0 + 1)
    const fx = gx - x0
    const fy = gy - y0
    const top = grid[y0 * gw + x0] * (1 - fx) + grid[y0 * gw + x1] * fx
    const bottom = grid[y1 * gw + x0] * (1 - fx) + grid[y1 * gw + x1] * fx
    return top * (1 - fy) + bottom * fy
  }
}

// ---------- messages ----------

// Electron's utilityProcess; a plain Node child process (fork, advanced serialization) for tests.
const port =
  process.parentPort ??
  (process.send
    ? { on: (_ev, fn) => process.on('message', (data) => fn({ data })), postMessage: (msg) => process.send(msg) }
    : null)

let chain = Promise.resolve()

port?.on('message', ({ data: msg }) => {
  if (msg.type === 'init') {
    init(msg)
      .then((info) => port.postMessage({ type: 'ready', ...info }))
      .catch((err) => port.postMessage({ type: 'ready', error: String(err?.message || err) }))
    return
  }
  if (msg.type === 'erase') {
    // one region at a time: the GPU is the bottleneck
    chain = chain.then(async () => {
      try {
        const res = await erase(msg)
        port.postMessage({
          type: 'result',
          seq: msg.seq,
          ok: true,
          data: new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength),
          out: { data: new Uint8Array(res.out.data.buffer, res.out.data.byteOffset, res.out.data.byteLength), iw: res.out.iw, ih: res.out.ih },
          ms: Math.round(res.ms),
          inferMs: Math.round(res.inferMs),
          device: device.label,
        })
      } catch (err) {
        port.postMessage({ type: 'result', seq: msg.seq, ok: false, error: String(err?.message || err) })
      }
    })
  }
})

module.exports = { init, erase, brushDistance, SIZE }
