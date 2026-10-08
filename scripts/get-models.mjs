// Downloads the models and data Lumen bundles into ./models. Run with: npm run models
//
//  - InsightFace "buffalo_l" (People: face detection + recognition)
//    https://github.com/deepinsight/insightface, release v0.7. NON-COMMERCIAL use only.
//  - SigLIP base patch16-224 (Search by what's in the photo), ONNX export by Xenova
//    https://huggingface.co/google/siglip-base-patch16-224, Apache 2.0.
//  - GeoNames cities1000 + admin1 + country names (Places), CC BY 4.0
//    https://www.geonames.org — reduced to models/places.json.gz.
//  - LaMa "big-lama" inpainting (Magic eraser), ONNX export by Carve (fixed 512×512 input)
//    https://huggingface.co/Carve/LaMa-ONNX, original https://github.com/advimman/lama, Apache 2.0.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gzipSync } from 'node:zlib'

const dir = join(import.meta.dirname, '..', 'models')
// Windows' bsdtar reads .zip files; GNU tar (e.g. from Git Bash) would treat 'D:' as a remote host.
const WIN_TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
const TAR = process.platform === 'win32' && existsSync(WIN_TAR) ? WIN_TAR : 'tar'
mkdirSync(dir, { recursive: true })

async function download(url, file) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  let shown = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', (chunk) => {
    got += chunk.length
    const pct = total ? Math.floor((got / total) * 10) * 10 : 0
    if (pct > shown) {
      shown = pct
      process.stdout.write(` ${pct}%`)
    }
  })
  console.log(`Downloading ${url}${total ? ` (${(total / 1048576).toFixed(1)} MB)` : ''}`)
  await pipeline(body, createWriteStream(file + '.part'))
  renameSync(file + '.part', file)
  if (total) process.stdout.write('\n')
}

async function range(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  if (res.status !== 206) throw new Error(`Range request failed: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

async function insightface() {
  const wanted = ['det_10g.onnx', 'w600k_r50.onnx']
  if (wanted.every((f) => existsSync(join(dir, f)))) return console.log('InsightFace: already present')
  const zip = join(tmpdir(), `lumen-buffalo_l-${Date.now()}.zip`)
  await download('https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip', zip)
  const entries = execFileSync(TAR, ['-tf', zip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
  for (const name of wanted) {
    const entry = entries.find((e) => e === name || e.endsWith(`/${name}`))
    if (!entry) throw new Error(`${name} not found in archive`)
    const strip = entry.split('/').length - 1
    execFileSync(TAR, ['-xf', zip, '-C', dir, ...(strip ? [`--strip-components=${strip}`] : []), entry])
    console.log(`  ${name}  sha256 ${sha256(join(dir, name))}`)
  }
  rmSync(zip, { force: true })
}

async function siglip() {
  const out = join(dir, 'siglip')
  mkdirSync(out, { recursive: true })
  const base = 'https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/'
  const files = {
    'vision_model_fp16.onnx': 'onnx/vision_model_fp16.onnx',
    'text_model_fp16.onnx': 'onnx/text_model_fp16.onnx',
    'tokenizer.json': 'tokenizer.json',
    'config.json': 'config.json',
    'preprocessor_config.json': 'preprocessor_config.json',
    'tokenizer_config.json': 'tokenizer_config.json',
  }
  for (const [name, remote] of Object.entries(files)) {
    if (existsSync(join(out, name))) continue
    await download(base + remote, join(out, name))
    if (name.endsWith('.onnx')) console.log(`  ${name}  sha256 ${sha256(join(out, name))}`)
  }

  // The separate vision/text exports drop SigLIP's two learned calibration scalars
  // (logit_scale, logit_bias), which turn a similarity into a match probability. Read just those
  // 8 bytes from Google's original safetensors file with HTTP range requests.
  const calib = join(out, 'calibration.json')
  if (!existsSync(calib)) {
    const url = 'https://huggingface.co/google/siglip-base-patch16-224/resolve/main/model.safetensors'
    const headerLen = Number((await range(url, 0, 7)).readBigUInt64LE(0))
    const header = JSON.parse((await range(url, 8, 8 + headerLen - 1)).toString('utf8'))
    const scalar = async (key) => {
      const t = header[key]
      if (!t || t.dtype !== 'F32') throw new Error(`${key} missing from safetensors header`)
      const [a] = t.data_offsets
      return (await range(url, 8 + headerLen + a, 8 + headerLen + a + 3)).readFloatLE(0)
    }
    const logitScale = await scalar('logit_scale')
    const logitBias = await scalar('logit_bias')
    writeFileSync(calib, JSON.stringify({ logitScale, logitBias, scale: Math.exp(logitScale) }, null, 1))
    console.log(`  calibration  scale=exp(${logitScale.toFixed(4)})  bias=${logitBias.toFixed(4)}`)
  }
}

async function places() {
  const target = join(dir, 'places.json.gz')
  if (existsSync(target)) return console.log('Places: already present')
  const raw = join(dir, 'geonames')
  mkdirSync(raw, { recursive: true })
  const base = 'https://download.geonames.org/export/dump/'
  for (const f of ['cities1000.zip', 'admin1CodesASCII.txt', 'countryInfo.txt'])
    if (!existsSync(join(raw, f))) await download(base + f, join(raw, f))
  if (!existsSync(join(raw, 'cities1000.txt'))) execFileSync(TAR, ['-xf', join(raw, 'cities1000.zip'), '-C', raw])

  const countries = {}
  for (const line of readFileSync(join(raw, 'countryInfo.txt'), 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const c = line.split('\t')
    countries[c[0]] = c[4]
  }
  const admin1 = new Map()
  for (const line of readFileSync(join(raw, 'admin1CodesASCII.txt'), 'utf8').split('\n')) {
    const c = line.split('\t')
    if (c.length > 1) admin1.set(c[0], c[1])
  }

  // Sections of cities, historical, abandoned and destroyed places would split one city into
  // neighbourhoods or name places that no longer exist.
  const SKIP = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH'])
  const rows = readFileSync(join(raw, 'cities1000.txt'), 'utf8')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((c) => c.length >= 15 && c[6] === 'P' && !SKIP.has(c[7]))
  // Some city districts are listed as towns of their own ("Paris 16 Passy", "Lyon 03"): drop a
  // place named "<bigger place nearby> <number>…" so those photos are filed under the city.
  const byName = new Map()
  for (const c of rows) {
    if (!byName.has(c[1])) byName.set(c[1], [])
    byName.get(c[1]).push(c)
  }
  const isDistrict = (c) => {
    const prefix = c[1].match(/^(.{3,}?)[\s,-]+\d/)?.[1]
    return !!byName.get(prefix)?.some(
      (big) => Number(big[14]) > Number(c[14]) && Math.hypot(big[4] - c[4], (big[5] - c[5]) * Math.cos(c[4] * (Math.PI / 180))) < 0.4,
    )
  }

  const admins = []
  const adminIndex = new Map()
  const p = { lat: [], lon: [], pop: [], name: [], cc: [], admin: [] }
  let districts = 0
  for (const c of rows) {
    if (isDistrict(c)) {
      districts++
      continue
    }
    const key = `${c[8]}.${c[10]}`
    let ai = adminIndex.get(key)
    if (ai === undefined) {
      ai = admins.push(admin1.get(key) ?? '') - 1
      adminIndex.set(key, ai)
    }
    p.lat.push(Math.round(Number(c[4]) * 1e4))
    p.lon.push(Math.round(Number(c[5]) * 1e4))
    p.pop.push(Number(c[14]) || 0)
    p.name.push(c[1])
    p.cc.push(c[8])
    p.admin.push(ai)
  }
  const json = JSON.stringify({
    version: 1,
    source: 'GeoNames cities1000 (CC BY 4.0), ' + new Date().toISOString().slice(0, 10),
    countries,
    admins,
    ...p,
  })
  writeFileSync(target, gzipSync(json, { level: 9 }))
  console.log(`  places.json.gz  ${p.name.length} places (${districts} city districts folded in), ${(gzipSync(json).length / 1048576).toFixed(1)} MB`)
}

// ---------- LaMa: download, then make it DirectML-ready ----------
//
// Carve's export computes its Fourier transforms with 5-D batched MatMuls ([H,H] @ [N,C,W,H,1]),
// which DirectML rejects, and rebuilds every DFT matrix from Shape/Range/Cos nodes on each run
// (17k nodes, ~20 s to load on the GPU). So, once, here:
//   1. the 5-D MatMuls become 4-D ones (the DFT matrices are symmetric: K @ Xᵀ = X @ K, laid out
//      as X) and the Squeeze after them an Identity;
//   2. every Shape node becomes a constant (the input is always 1×3×512×512), measured by one run;
//   3. ONNX Runtime's basic optimiser folds the rest (2.9k nodes; loads in ~2 s);
//   4. the result is checked against the unoptimised graph on a test picture.
// Same weights, same output (max difference 0.000 on CPU and GPU when this was written).

const pbVarint = (n) => {
  const out = []
  let v = BigInt(n)
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return Buffer.from(out)
}
function pbRead(buf, pos) {
  let r = 0
  let mul = 1
  let b
  do {
    b = buf[pos++]
    r += (b & 0x7f) * mul
    mul *= 128
  } while (b & 0x80)
  return [r, pos]
}
/** A protobuf message's fields: { num, value (bytes of a length-delimited field), raw }. */
function pbFields(buf) {
  const out = []
  let pos = 0
  while (pos < buf.length) {
    const start = pos
    let key
    ;[key, pos] = pbRead(buf, pos)
    const wire = key & 7
    let value = null
    if (wire === 0) [, pos] = pbRead(buf, pos)
    else if (wire === 2) {
      let len
      ;[len, pos] = pbRead(buf, pos)
      value = buf.subarray(pos, pos + len)
      pos += len
    } else if (wire === 5) pos += 4
    else if (wire === 1) pos += 8
    else throw new Error('Unexpected protobuf wire type')
    out.push({ num: Math.floor(key / 8), value, raw: buf.subarray(start, pos) })
  }
  return out
}
const pbBytes = (num, bytes) => Buffer.concat([pbVarint(num * 8 + 2), pbVarint(bytes.length), Buffer.from(bytes)])
const pbInt = (num, v) => Buffer.concat([pbVarint(num * 8), pbVarint(v)])
const pbText = (f) => (f ? f.value.toString('utf8') : '')

/** ModelProto → { nodes: [{ i, f, op, input, output }], rebuild(replaced, extra) }. */
function onnxGraph(model) {
  const top = pbFields(model)
  const gi = top.findIndex((f) => f.num === 7) // ModelProto.graph
  const graph = pbFields(top[gi].value)
  const nodes = []
  graph.forEach((g, i) => {
    if (g.num !== 1) return // GraphProto.node
    const f = pbFields(g.value)
    nodes.push({
      i,
      f,
      op: pbText(f.find((x) => x.num === 4)),
      input: f.filter((x) => x.num === 1).map(pbText),
      output: f.filter((x) => x.num === 2).map(pbText),
    })
  })
  const rebuild = (replaced, extra = []) => {
    const g = Buffer.concat([...graph.map((x, i) => replaced.get(i) ?? x.raw), ...extra])
    return Buffer.concat(top.map((x, i) => (i === gi ? pbBytes(7, g) : x.raw)))
  }
  return { nodes, rebuild }
}

function lamaTo4d(model) {
  const { nodes, rebuild } = onnxGraph(model)
  const producer = new Map()
  for (const n of nodes) for (const o of n.output) producer.set(o, n)
  const replaced = new Map()
  for (const n of nodes) {
    if (n.op === 'MatMul') {
      const k = producer.get(n.input[0])
      const u = producer.get(n.input[1])
      if (!k || !u || (k.op !== 'Cos' && k.op !== 'Sin') || u.op !== 'Unsqueeze') continue
      const rest = n.f.filter((x) => x.num !== 1).map((x) => x.raw)
      replaced.set(n.i, pbBytes(1, Buffer.concat([pbBytes(1, u.input[0]), pbBytes(1, n.input[0]), ...rest])))
    } else if (n.op === 'Squeeze') {
      const src = producer.get(n.input[0])
      const mm = src && producer.get(src.input[0])
      if (!src || (src.op !== 'Sub' && src.op !== 'Add') || mm?.op !== 'MatMul' || !replaced.has(mm.i)) continue
      const rest = n.f.filter((x) => x.num !== 1 && x.num !== 4 && x.num !== 5).map((x) => x.raw)
      replaced.set(n.i, pbBytes(1, Buffer.concat([pbBytes(1, n.input[0]), ...rest, pbBytes(4, 'Identity')])))
    }
  }
  const matmuls = nodes.filter((n) => n.op === 'MatMul' && replaced.has(n.i)).length
  if (matmuls !== 144) throw new Error(`LaMa graph not as expected (${matmuls} Fourier MatMuls)`)
  return rebuild(replaced)
}

async function prepareLama(source, target) {
  const require = createRequire(import.meta.url)
  const ort = require('onnxruntime-node')
  const opts = { executionProviders: ['cpu'], logSeverityLevel: 3 }
  const S = 512
  const image = new Float32Array(3 * S * S)
  for (let i = 0; i < image.length; i++) image[i] = 0.45 + 0.3 * Math.sin(i / 2900) * Math.cos((i % S) / 37)
  const mask = new Float32Array(S * S)
  for (let y = 180; y < 330; y++) for (let x = 200; x < 300; x++) mask[y * S + x] = 1
  const feeds = () => ({ image: new ort.Tensor('float32', image, [1, 3, S, S]), mask: new ort.Tensor('float32', mask, [1, 1, S, S]) })

  const patched = lamaTo4d(readFileSync(source))
  const graph = onnxGraph(patched)
  const shapes = graph.nodes.filter((n) => n.op === 'Shape')
  const probe = await ort.InferenceSession.create(
    graph.rebuild(new Map(), shapes.map((n) => pbBytes(12, pbBytes(1, n.output[0])))), // extra graph outputs
    { ...opts, graphOptimizationLevel: 'disabled' },
  )
  const seen = await probe.run(feeds(), ['output', ...shapes.map((n) => n.output[0])])
  await probe.release?.()
  const constants = new Map()
  for (const n of shapes) {
    const v = seen[n.output[0]]
    const tensor = Buffer.concat([pbInt(1, v.dims[0]), pbInt(2, 7), pbBytes(9, Buffer.from(BigInt64Array.from(v.data).buffer))])
    const attr = Buffer.concat([pbBytes(1, 'value'), pbBytes(5, tensor), pbInt(20, 4)])
    const name = n.f.find((x) => x.num === 3)
    constants.set(n.i, pbBytes(1, Buffer.concat([pbBytes(2, n.output[0]), ...(name ? [name.raw] : []), pbBytes(4, 'Constant'), pbBytes(5, attr)])))
  }
  const part = target + '.part'
  const opt = await ort.InferenceSession.create(graph.rebuild(constants), { ...opts, graphOptimizationLevel: 'basic', optimizedModelFilePath: part })
  await opt.release?.()
  const check = await ort.InferenceSession.create(part, { ...opts, graphOptimizationLevel: 'all' })
  const got = (await check.run(feeds())).output.data
  await check.release?.()
  const want = seen.output.data
  let diff = 0
  for (let i = 0; i < want.length; i++) diff = Math.max(diff, Math.abs(want[i] - got[i]))
  if (!(diff < 0.5)) {
    rmSync(part, { force: true })
    throw new Error(`Prepared LaMa model differs from the original (max ${diff})`)
  }
  renameSync(part, target)
  console.log(`  lama.onnx  ${shapes.length} shapes frozen, max difference ${diff.toFixed(3)}, sha256 ${sha256(target)}`)
}

async function lama() {
  const out = join(dir, 'lama')
  const target = join(out, 'lama.onnx')
  if (existsSync(target)) return console.log('LaMa: already present')
  mkdirSync(out, { recursive: true })
  console.log('LaMa inpainting (Magic eraser) — Apache 2.0, https://github.com/advimman/lama')
  // pinned to the revision that was tested; the hash is the file's Git LFS id
  const rev = 'c3c0c9e468934d62e79c329e35d82dd09ff8c444'
  const want = '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6'
  const file = join(out, 'lama_fp32.onnx')
  if (!existsSync(file) || sha256(file) !== want) {
    await download(`https://huggingface.co/Carve/LaMa-ONNX/resolve/${rev}/lama_fp32.onnx`, file + '.download')
    const got = sha256(file + '.download')
    if (got !== want) {
      rmSync(file + '.download', { force: true })
      throw new Error(`lama_fp32.onnx: unexpected sha256 ${got}`)
    }
    renameSync(file + '.download', file)
  }
  console.log(`  lama_fp32.onnx  sha256 ${want}`)
  await prepareLama(file, target)
  rmSync(file) // only the prepared copy is bundled
}

await insightface()
await siglip()
await places()
await lama()
console.log('Done:', dir)
