// Face engine — runs in its own process (Electron utilityProcess, see faces.cjs).
//
// InsightFace "buffalo_l" models on ONNX Runtime:
//   1. SCRFD-10G (det_10g.onnx) finds faces + 5 landmarks (eyes, nose tip, mouth corners)
//   2. each face is aligned to InsightFace's 112×112 template with a similarity transform
//   3. ArcFace ResNet-50 (w600k_r50.onnx) turns it into a 512-number faceprint (L2-normalised)
// On Windows the models run on the GPU through DirectML; the fastest adapter is picked by timing
// them (on dual-GPU laptops adapter 0 is usually the integrated one).
const fs = require('node:fs')
const path = require('node:path')
const ort = require('onnxruntime-node')
const sharp = require('sharp')

sharp.cache(false)
ort.env.logLevel = 'error'

const DET_SIZE = 640
const DET_THRESH = 0.5
const NMS_IOU = 0.4
const STRIDES = [8, 16, 32]
const ARC_SIZE = 112
// InsightFace's reference landmark positions in the 112×112 aligned face.
const ARC_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]

let det = null
let rec = null
let detOutputs = null

const port = process.parentPort

async function createSessions(modelsDir, providers) {
  const opts = { executionProviders: providers, logSeverityLevel: 3, graphOptimizationLevel: 'all' }
  const d = await ort.InferenceSession.create(path.join(modelsDir, 'det_10g.onnx'), opts)
  const r = await ort.InferenceSession.create(path.join(modelsDir, 'w600k_r50.onnx'), opts)
  return { d, r }
}

async function timeDetector(session) {
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * DET_SIZE * DET_SIZE), [1, 3, DET_SIZE, DET_SIZE]) }
  await session.run(feeds)
  const t = performance.now()
  for (let i = 0; i < 4; i++) await session.run(feeds)
  return (performance.now() - t) / 4
}

/** Picks the fastest DirectML adapter (falls back to the CPU). */
async function init({ modelsDir, cacheFile }) {
  for (const f of ['det_10g.onnx', 'w600k_r50.onnx']) {
    if (!fs.existsSync(path.join(modelsDir, f))) throw new Error(`Face model missing: ${f}`)
  }
  let cached = null
  try {
    cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  } catch {}

  const candidates = []
  if (process.platform === 'win32') {
    const ids = Number.isInteger(cached?.adapter) ? [cached.adapter] : [0, 1, 2, 3]
    for (const deviceId of ids) {
      try {
        const s = await createSessions(modelsDir, [{ name: 'dml', deviceId }])
        candidates.push({ ...s, label: `gpu${deviceId}`, adapter: deviceId, ms: ids.length > 1 ? await timeDetector(s.d) : 0 })
      } catch {
        if (ids.length === 1) return init({ modelsDir, cacheFile: null }) // cached adapter gone: re-pick
        break // no more adapters
      }
    }
  }
  if (!candidates.length) {
    const s = await createSessions(modelsDir, ['cpu'])
    candidates.push({ ...s, label: 'cpu', adapter: null, ms: 0 })
  }
  candidates.sort((a, b) => a.ms - b.ms)
  const best = candidates[0]
  det = best.d
  rec = best.r
  for (const c of candidates.slice(1)) {
    c.d.release?.()
    c.r.release?.()
  }
  if (cacheFile && best.adapter !== null) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ adapter: best.adapter }))
    } catch {}
  }
  // outputs come as 3 score maps, 3 box maps, 3 landmark maps (strides 8, 16, 32)
  detOutputs = det.outputNames
  return { device: best.adapter === null ? 'cpu' : 'gpu', adapter: best.adapter, timings: candidates.map((c) => [c.label, Math.round(c.ms * 10) / 10]) }
}

// ---------- detection ----------

async function decode(jpeg) {
  const full = await sharp(jpeg, { failOn: 'none' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = full.info
  const scale = Math.min(DET_SIZE / width, DET_SIZE / height)
  const dw = Math.max(1, Math.round(width * scale))
  const dh = Math.max(1, Math.round(height * scale))
  const small = await sharp(full.data, { raw: { width, height, channels: 3 } }).resize(dw, dh, { kernel: 'linear' }).raw().toBuffer()
  return { rgb: full.data, width, height, small, dw, dh, scale }
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2])
  const y2 = Math.min(a[3], b[3])
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1])
  return inter / (area(a) + area(b) - inter || 1)
}

async function detect(img) {
  const plane = DET_SIZE * DET_SIZE
  // Letterboxed into the top-left corner; padding is black (pixel 0), as in InsightFace.
  const input = new Float32Array(3 * plane).fill(-127.5 / 128)
  for (let y = 0; y < img.dh; y++) {
    for (let x = 0; x < img.dw; x++) {
      const s = (y * img.dw + x) * 3
      const d = y * DET_SIZE + x
      input[d] = (img.small[s] - 127.5) / 128
      input[plane + d] = (img.small[s + 1] - 127.5) / 128
      input[2 * plane + d] = (img.small[s + 2] - 127.5) / 128
    }
  }
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]) })
  const found = []
  STRIDES.forEach((stride, i) => {
    const scores = out[detOutputs[i]].data
    const boxes = out[detOutputs[i + 3]].data
    const kps = out[detOutputs[i + 6]].data
    const cols = DET_SIZE / stride
    for (let k = 0; k < scores.length; k++) {
      if (scores[k] < DET_THRESH) continue
      const cell = k >> 1 // two anchors per grid cell
      const cx = (cell % cols) * stride
      const cy = Math.floor(cell / cols) * stride
      const inv = 1 / img.scale
      const box = [
        (cx - boxes[k * 4] * stride) * inv,
        (cy - boxes[k * 4 + 1] * stride) * inv,
        (cx + boxes[k * 4 + 2] * stride) * inv,
        (cy + boxes[k * 4 + 3] * stride) * inv,
      ]
      const points = []
      for (let j = 0; j < 5; j++) points.push([(cx + kps[k * 10 + j * 2] * stride) * inv, (cy + kps[k * 10 + j * 2 + 1] * stride) * inv])
      found.push({ score: scores[k], box, points })
    }
  })
  found.sort((a, b) => b.score - a.score)
  const kept = []
  for (const f of found) {
    if (kept.length >= 60) break
    if (kept.every((k) => iou(k.box, f.box) < NMS_IOU)) kept.push(f)
  }
  return kept
}

// ---------- alignment + recognition ----------

/** Least-squares similarity transform (rotation + uniform scale + shift) mapping src → dst. */
function similarity(src, dst) {
  const n = src.length
  let sx = 0, sy = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]
  }
  sx /= n; sy /= n; dx /= n; dy /= n
  let num1 = 0, num2 = 0, den = 0
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx, py = src[i][1] - sy
    const qx = dst[i][0] - dx, qy = dst[i][1] - dy
    num1 += px * qx + py * qy
    num2 += px * qy - py * qx
    den += px * px + py * py
  }
  const a = num1 / den
  const b = num2 / den
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) }
}

function alignedTensor(img, points) {
  const { a, b, tx, ty } = similarity(points, ARC_TEMPLATE)
  // inverse: dst pixel → source pixel
  const det2 = a * a + b * b
  const plane = ARC_SIZE * ARC_SIZE
  const out = new Float32Array(3 * plane)
  const { rgb, width: W, height: H } = img
  const sample = (xx, yy, c) => (xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : rgb[(yy * W + xx) * 3 + c])
  for (let v = 0; v < ARC_SIZE; v++) {
    for (let u = 0; u < ARC_SIZE; u++) {
      const ux = u - tx
      const vy = v - ty
      const x = (a * ux + b * vy) / det2
      const y = (-b * ux + a * vy) / det2
      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      const fx = x - x0
      const fy = y - y0
      const o = v * ARC_SIZE + u
      for (let c = 0; c < 3; c++) {
        // bilinear, black outside the photo (like cv2.warpAffine's default border)
        const val =
          sample(x0, y0, c) * (1 - fx) * (1 - fy) +
          sample(x0 + 1, y0, c) * fx * (1 - fy) +
          sample(x0, y0 + 1, c) * (1 - fx) * fy +
          sample(x0 + 1, y0 + 1, c) * fx * fy
        out[c * plane + o] = (val - 127.5) / 127.5
      }
    }
  }
  return out
}

async function embed(img, points) {
  const input = new ort.Tensor('float32', alignedTensor(img, points), [1, 3, ARC_SIZE, ARC_SIZE])
  const out = await rec.run({ [rec.inputNames[0]]: input })
  const v = Float32Array.from(out[rec.outputNames[0]].data)
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

// ---------- jobs ----------

let chain = Promise.resolve()

async function analyze(img) {
  const faces = await detect(img)
  const result = []
  for (const f of faces) {
    const [x1, y1, x2, y2] = f.box
    const x = Math.max(0, x1) / img.width
    const y = Math.max(0, y1) / img.height
    const w = Math.min(img.width, x2) / img.width - x
    const h = Math.min(img.height, y2) / img.height - y
    if (w <= 0 || h <= 0) continue
    result.push({ box: [x, y, w, h], score: f.score, embedding: await embed(img, f.points) })
  }
  return { width: img.width, height: img.height, faces: result }
}

port.on('message', ({ data: msg }) => {
  if (msg.type === 'init') {
    init(msg)
      .then((info) => port.postMessage({ type: 'ready', ...info }))
      .catch((err) => port.postMessage({ type: 'ready', error: String(err?.message || err) }))
    return
  }
  if (msg.type === 'analyze') {
    // Decoding starts right away (overlapping the previous photo's inference); GPU work runs one
    // photo at a time.
    const decoded = decode(Buffer.from(msg.jpeg)).catch((err) => ({ error: err }))
    chain = chain.then(async () => {
      try {
        const img = await decoded
        if (img.error) throw img.error
        const res = await analyze(img)
        port.postMessage({ type: 'result', seq: msg.seq, ok: true, ...res })
      } catch (err) {
        port.postMessage({ type: 'result', seq: msg.seq, ok: false, error: String(err?.message || err) })
      }
    })
  }
})
