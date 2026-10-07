// Downloads the models and data Lumen bundles into ./models. Run with: npm run models
//
//  - InsightFace "buffalo_l" (People: face detection + recognition)
//    https://github.com/deepinsight/insightface, release v0.7. NON-COMMERCIAL use only.
//  - SigLIP base patch16-224 (Search by what's in the photo), ONNX export by Xenova
//    https://huggingface.co/google/siglip-base-patch16-224, Apache 2.0.
//  - GeoNames cities1000 + admin1 + country names (Places), CC BY 4.0
//    https://www.geonames.org — reduced to models/places.json.gz.
import { createHash } from 'node:crypto'
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

await insightface()
await siglip()
await places()
console.log('Done:', dir)
