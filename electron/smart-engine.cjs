// Smart search engine — runs in its own process (Electron utilityProcess, see smart.cjs).
//
// Google's SigLIP (base, patch 16, 224 px) turns a photo and a piece of text into 768 numbers each,
// in the same space: the closer they point, the better the text describes the photo. Photos are
// embedded once in the background; a search only embeds the query text. On Windows it runs on the
// GPU through DirectML (the fastest adapter, as for faces), else on the CPU.
const fs = require('node:fs')
const path = require('node:path')
const ort = require('onnxruntime-node')
const sharp = require('sharp')

sharp.cache(false)
ort.env.logLevel = 'error'

const SIZE = 224
const MAX_TOKENS = 64
const EOS = 1 // "</s>", also used as padding
const UNK = 2
// HF SiglipTokenizer.canonicalize_text: punctuation removed, lower case, single spaces
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g

let vision = null
let text = null
let tokenizer = null
const port = process.parentPort

/** SentencePiece unigram tokenizer (Viterbi over the vocabulary's log-probabilities). */
class Unigram {
  constructor(file) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    this.pieces = new Map()
    let min = 0
    let maxLen = 1
    json.model.vocab.forEach(([piece, score], id) => {
      if (id < 3) return // <pad> </s> <unk>
      this.pieces.set(piece, [id, score])
      min = Math.min(min, score)
      maxLen = Math.max(maxLen, [...piece].length)
    })
    this.unkScore = min - 10
    this.maxLen = maxLen
  }

  word(word) {
    const chars = [...word]
    const n = chars.length
    const best = new Float64Array(n + 1).fill(-Infinity)
    const from = new Int32Array(n + 1)
    const ids = new Int32Array(n + 1)
    best[0] = 0
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue
      let piece = ''
      let single = false
      for (let j = i; j < Math.min(n, i + this.maxLen); j++) {
        piece += chars[j]
        const hit = this.pieces.get(piece)
        if (!hit) continue
        if (j === i) single = true
        const score = best[i] + hit[1]
        if (score > best[j + 1]) {
          best[j + 1] = score
          from[j + 1] = i
          ids[j + 1] = hit[0]
        }
      }
      if (!single && best[i] + this.unkScore > best[i + 1]) {
        best[i + 1] = best[i] + this.unkScore
        from[i + 1] = i
        ids[i + 1] = UNK
      }
    }
    const out = []
    for (let k = n; k > 0; k = from[k]) out.push(ids[k])
    out.reverse()
    return out.filter((id, i) => id !== UNK || out[i - 1] !== UNK) // consecutive unknowns fuse
  }

  encode(textIn) {
    const clean = textIn.normalize('NFKC').toLowerCase().replace(PUNCTUATION, '').replace(/\s+/g, ' ').trim()
    const ids = []
    for (const w of clean.split(' ')) if (w) ids.push(...this.word('▁' + w))
    ids.length = Math.min(ids.length, MAX_TOKENS - 1)
    ids.push(EOS)
    while (ids.length < MAX_TOKENS) ids.push(EOS)
    return ids
  }
}

async function createSessions(dir, providers) {
  const opts = { executionProviders: providers, logSeverityLevel: 3, graphOptimizationLevel: 'all' }
  const v = await ort.InferenceSession.create(path.join(dir, 'vision_model_fp16.onnx'), opts)
  const t = await ort.InferenceSession.create(path.join(dir, 'text_model_fp16.onnx'), opts)
  return { v, t }
}

async function timeVision(session) {
  const feeds = { pixel_values: new ort.Tensor('float32', new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]) }
  await session.run(feeds)
  const t = performance.now()
  for (let i = 0; i < 4; i++) await session.run(feeds)
  return (performance.now() - t) / 4
}

const readAdapter = (file) => {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8')).adapter
    return Number.isInteger(a) ? a : null
  } catch {
    return null
  }
}

/**
 * Loads the models on the fastest GPU. The adapter picked for faces (or for this engine before) is
 * tried first; otherwise every DirectML adapter is timed.
 */
async function init({ modelsDir, cacheFile, hintFile }) {
  const dir = path.join(modelsDir, 'siglip')
  for (const f of ['vision_model_fp16.onnx', 'text_model_fp16.onnx', 'tokenizer.json']) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`Search model missing: ${f}`)
  }
  tokenizer = new Unigram(path.join(dir, 'tokenizer.json'))

  const candidates = []
  if (process.platform === 'win32') {
    const known = readAdapter(cacheFile) ?? readAdapter(hintFile)
    const ids = known !== null ? [known] : [0, 1, 2, 3]
    for (const deviceId of ids) {
      try {
        const s = await createSessions(dir, [{ name: 'dml', deviceId }])
        candidates.push({ ...s, adapter: deviceId, ms: await timeVision(s.v) })
      } catch {
        if (ids.length === 1) return init({ modelsDir, cacheFile: null, hintFile: null }) // adapter gone
        break
      }
    }
  }
  if (!candidates.length) {
    const s = await createSessions(dir, ['cpu'])
    candidates.push({ ...s, adapter: null, ms: await timeVision(s.v) })
  }
  candidates.sort((a, b) => a.ms - b.ms)
  const best = candidates[0]
  vision = best.v
  text = best.t
  for (const c of candidates.slice(1)) {
    c.v.release?.()
    c.t.release?.()
  }
  if (cacheFile && best.adapter !== null) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ adapter: best.adapter }))
    } catch {}
  }
  return {
    device: best.adapter === null ? 'cpu' : 'gpu',
    adapter: best.adapter,
    timings: candidates.map((c) => [c.adapter === null ? 'cpu' : `gpu${c.adapter}`, Math.round(c.ms * 10) / 10]),
  }
}

const normalize = (data) => {
  const v = Float32Array.from(data)
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

/** SigLIP preprocessing: squash to 224×224 (bicubic), scale to [-1, 1], planar RGB. */
async function pixels(image) {
  const rgb = await sharp(image, { failOn: 'none' })
    .flatten({ background: '#ffffff' })
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'cubic' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const plane = SIZE * SIZE
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    out[i] = rgb[i * 3] / 127.5 - 1
    out[plane + i] = rgb[i * 3 + 1] / 127.5 - 1
    out[2 * plane + i] = rgb[i * 3 + 2] / 127.5 - 1
  }
  return out
}

async function embedImage(input) {
  const out = await vision.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) })
  return normalize(out.pooler_output.data)
}

async function embedText(query) {
  const ids = BigInt64Array.from(tokenizer.encode(query), (n) => BigInt(n))
  const out = await text.run({ input_ids: new ort.Tensor('int64', ids, [1, MAX_TOKENS]) })
  return normalize(out.pooler_output.data)
}

// ---------- jobs: text (someone is waiting) before images (background) ----------

const textJobs = []
const imageJobs = []
let busy = false

async function drain() {
  if (busy) return
  busy = true
  while (textJobs.length || imageJobs.length) {
    const job = textJobs.shift() ?? imageJobs.shift()
    try {
      const vec = job.type === 'text' ? await embedText(job.text) : await embedImage(await job.input)
      port.postMessage({ type: 'result', seq: job.seq, ok: true, vec })
    } catch (err) {
      port.postMessage({ type: 'result', seq: job.seq, ok: false, error: String(err?.message || err) })
    }
  }
  busy = false
}

port.on('message', ({ data: msg }) => {
  if (msg.type === 'init') {
    init(msg)
      .then((info) => port.postMessage({ type: 'ready', ...info }))
      .catch((err) => port.postMessage({ type: 'ready', error: String(err?.message || err) }))
    return
  }
  if (msg.type === 'text') {
    textJobs.push(msg)
    drain()
  } else if (msg.type === 'image') {
    // decoding starts now, overlapping the inference of the photos ahead of it
    const input = pixels(Buffer.from(msg.data))
    input.catch(() => {})
    imageJobs.push({ ...msg, input })
    drain()
  }
})
