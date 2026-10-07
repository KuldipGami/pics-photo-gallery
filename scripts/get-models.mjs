// Downloads the InsightFace "buffalo_l" models used for People (face detection + recognition)
// into ./models. Run with: npm run models
//
// Source: https://github.com/deepinsight/insightface (release v0.7). The pretrained models are
// licensed for NON-COMMERCIAL use only.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip'
const WANTED = ['det_10g.onnx', 'w600k_r50.onnx']
const dir = join(import.meta.dirname, '..', 'models')

if (WANTED.every((f) => existsSync(join(dir, f)))) {
  console.log('Models already present in', dir)
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
const zip = join(tmpdir(), `lumen-buffalo_l-${Date.now()}.zip`)
console.log('Downloading', URL)
const res = await fetch(URL)
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
writeFileSync(zip, Buffer.from(await res.arrayBuffer()))

// Windows 10+ ships bsdtar, which reads .zip files.
const entries = execFileSync('tar', ['-tf', zip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
for (const name of WANTED) {
  const entry = entries.find((e) => e === name || e.endsWith(`/${name}`))
  if (!entry) throw new Error(`${name} not found in archive`)
  const strip = entry.split('/').length - 1
  execFileSync('tar', ['-xf', zip, '-C', dir, ...(strip ? [`--strip-components=${strip}`] : []), entry])
  const sha = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')
  console.log(`  ${name}  sha256 ${sha}`)
}
rmSync(zip, { force: true })
console.log('Done:', dir)
