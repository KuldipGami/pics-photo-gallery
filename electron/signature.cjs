// Perceptual fingerprint of a picture (ported from DupeLens' ImageSignature / ImageAnalyzer).
//
// The photo, as displayed, is shrunk to 384 px and turned grey, then box-averaged into a 72×72
// grid. Two 64-bit difference hashes (rows of 9 cells compared left→right, columns of 9 cells
// compared top→bottom) are taken for the grid in all 8 orientations (4 rotations × mirrored or
// not), plus upright hashes of 4 centre crops. So resized, re-saved, edited, rotated, mirrored and
// cropped copies all land close together. Distances are Hamming distances over 128 bits.
//
// Storage: one Uint32Array of 48 words per picture (64-bit hashes as hi/lo word pairs):
//   0–15  H[0..7]   16–31  V[0..7]   32–39  cropH[0..3]   40–47  cropV[0..3]
const GRID = 72
const BITS = 128
const CROPS = 4
const CROP_PENALTY = 3
const ANALYSIS_SIZE = 384
const WORDS = 48
const H0 = 0
const V0 = 16
const CH0 = 32
const CV0 = 40

function popcount(n) {
  n -= (n >>> 1) & 0x55555555
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

/** Box-averages a rectangle of a greyscale image into a 72×72 grid (aspect ratio ignored on purpose). */
function resampleRegion(px, stride, x0, y0, w, h) {
  const sums = new Int32Array(GRID * GRID)
  const counts = new Int32Array(GRID * GRID)
  for (let y = 0; y < h; y++) {
    const gy = Math.floor((y * GRID) / h)
    const row = (y0 + y) * stride + x0
    for (let x = 0; x < w; x++) {
      const cell = gy * GRID + Math.floor((x * GRID) / w)
      sums[cell] += px[row + x]
      counts[cell]++
    }
  }
  const grid = new Uint8Array(GRID * GRID)
  for (let i = 0; i < grid.length; i++) grid[i] = counts[i] ? Math.floor(sums[i] / counts[i]) : 0
  return grid
}

function centreCrop(px, w, h, fraction) {
  const cw = Math.max(GRID, Math.floor(w * fraction))
  const ch = Math.max(GRID, Math.floor(h * fraction))
  return resampleRegion(px, w, Math.floor((w - cw) / 2), Math.floor((h - ch) / 2), Math.min(cw, w), Math.min(ch, h))
}

/** Clockwise. */
function rotate90(px) {
  const out = new Uint8Array(px.length)
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) out[x * GRID + (GRID - 1 - y)] = px[y * GRID + x]
  return out
}

function mirror(px) {
  const out = new Uint8Array(px.length)
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) out[y * GRID + (GRID - 1 - x)] = px[y * GRID + x]
  return out
}

/** Writes a 64-bit hash (MSB first) into words[at], words[at + 1]. */
function putBits(words, at, bits) {
  let hi = 0
  let lo = 0
  for (let i = 0; i < 32; i++) hi = (hi << 1) | bits[i]
  for (let i = 32; i < 64; i++) lo = (lo << 1) | bits[i]
  words[at] = hi >>> 0
  words[at + 1] = lo >>> 0
}

// 9 columns × 8 rows of 8×9 px cells, each compared with its right neighbour.
function horizontalHash(px, words, at) {
  const cells = new Int32Array(72)
  for (let y = 0; y < GRID; y++) {
    const row = Math.floor(y / 9)
    for (let x = 0; x < GRID; x++) cells[row * 9 + Math.floor(x / 8)] += px[y * GRID + x]
  }
  const bits = new Uint8Array(64)
  let i = 0
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) bits[i++] = cells[r * 9 + c] > cells[r * 9 + c + 1] ? 1 : 0
  putBits(words, at, bits)
}

// 8 columns × 9 rows of 9×8 px cells, each compared with the one below.
function verticalHash(px, words, at) {
  const cells = new Int32Array(72)
  for (let y = 0; y < GRID; y++) {
    const row = Math.floor(y / 8)
    for (let x = 0; x < GRID; x++) cells[row * 8 + Math.floor(x / 9)] += px[y * GRID + x]
  }
  const bits = new Uint8Array(64)
  let i = 0
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) bits[i++] = cells[r * 8 + c] > cells[(r + 1) * 8 + c] ? 1 : 0
  putBits(words, at, bits)
}

function fromGrid(grid, crops) {
  const words = new Uint32Array(WORDS)
  let current = grid
  for (let r = 0; r < 4; r++) {
    horizontalHash(current, words, H0 + r * 2)
    verticalHash(current, words, V0 + r * 2)
    current = rotate90(current)
  }
  current = mirror(grid)
  for (let r = 0; r < 4; r++) {
    horizontalHash(current, words, H0 + (4 + r) * 2)
    verticalHash(current, words, V0 + (4 + r) * 2)
    current = rotate90(current)
  }
  if (crops) {
    for (let k = 0; k < CROPS; k++) {
      horizontalHash(crops[k], words, CH0 + k * 2)
      verticalHash(crops[k], words, CV0 + k * 2)
    }
  }
  return words
}

function mean(px) {
  let sum = 0
  for (const v of px) sum += v
  return sum / px.length
}

/** Variance of the Laplacian: few sharp edges = blurry. */
function laplacianVariance(p, w, h) {
  if (w < 3 || h < 3) return 0
  let sum = 0
  let squares = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    const row = y * w
    for (let x = 1; x < w - 1; x++) {
      const i = row + x
      const lap = 4 * p[i] - p[i - 1] - p[i + 1] - p[i - w] - p[i + w]
      sum += lap
      squares += lap * lap
      n++
    }
  }
  const m = sum / n
  return squares / n - m * m
}

function standardDeviation(px) {
  let sum = 0
  let squares = 0
  for (const v of px) {
    sum += v
    squares += v * v
  }
  const m = sum / px.length
  return Math.sqrt(Math.max(0, squares / px.length - m * m))
}

/**
 * Fingerprint + quality of an upright greyscale image (`w`×`h`, long side ≤ 384). `tiny72` is a
 * 72×72 decode used when the picture is smaller than the grid.
 */
function analyze(gray, w, h, tiny72) {
  const brightness = mean(gray)
  const sharpness = laplacianVariance(gray, w, h)
  let grid
  let crops = null
  if (w >= GRID && h >= GRID) {
    grid = resampleRegion(gray, w, 0, 0, w, h)
    const side = Math.min(w, h)
    crops = [
      resampleRegion(gray, w, Math.floor((w - side) / 2), Math.floor((h - side) / 2), side, side),
      centreCrop(gray, w, h, 0.85),
      centreCrop(gray, w, h, 0.75),
      centreCrop(gray, w, h, 0.65),
    ]
  } else {
    grid = tiny72
  }
  return {
    words: fromGrid(grid, crops),
    crops: !!crops,
    lowDetail: standardDeviation(grid) < 4, // blank / single-colour pictures would match everything
    sharpness: +sharpness.toFixed(1),
    brightness: +brightness.toFixed(1),
  }
}

/** Fingerprint of a video frame (upright only). */
function frameWords(grid) {
  const words = new Uint32Array(4)
  horizontalHash(grid, words, 0)
  verticalHash(grid, words, 2)
  return words
}

const pair = (a, ai, b, bi) => popcount(a[ai] ^ b[bi]) + popcount(a[ai + 1] ^ b[bi + 1])

/** Upright / rotated / mirrored distance, no crops. */
function distance(a, b) {
  let best = BITS
  for (let r = 0; r < 8; r++) {
    const d = pair(a, H0, b, H0 + r * 2) + pair(a, V0, b, V0 + r * 2)
    if (d < best) best = d
  }
  return best
}

/**
 * How `b` relates to `a`: { distance, kind: 'same'|'rotated'|'mirrored'|'cropped', rotation }.
 * `rotation` = clockwise quarter turns that make b look like a.
 */
function compare(a, aCrops, b, bCrops) {
  let best = BITS
  let kind = 'same'
  let rotation = 0
  for (let r = 0; r < 8; r++) {
    const d = pair(a, H0, b, H0 + r * 2) + pair(a, V0, b, V0 + r * 2)
    if (d < best || (d === best && r === 0)) {
      best = d
      kind = r === 0 ? 'same' : r < 4 ? 'rotated' : 'mirrored'
      rotation = r % 4
    }
  }
  if (aCrops && bCrops) {
    // a crop must fit clearly better than the plain comparison to count
    for (let k = 0; k < CROPS; k++) {
      const d1 = pair(a, CH0 + k * 2, b, H0) + pair(a, CV0 + k * 2, b, V0)
      const d2 = pair(a, H0, b, CH0 + k * 2) + pair(a, V0, b, CV0 + k * 2)
      const d = Math.min(d1, d2) + CROP_PENALTY
      if (d < best) {
        best = d
        kind = 'cropped'
        rotation = 0
      }
    }
  }
  return { distance: best, kind, rotation }
}

/** True when `candidate` looks like a centre crop of `original`. */
function isCropOf(candidate, original, originalCrops) {
  if (!originalCrops) return false
  const plain = distance(original, candidate)
  let crop = BITS
  for (let k = 0; k < CROPS; k++) crop = Math.min(crop, pair(original, CH0 + k * 2, candidate, H0) + pair(original, CV0 + k * 2, candidate, V0))
  return crop + CROP_PENALTY < plain
}

const maxDistanceFor = (similarity) => Math.floor((1 - Math.min(1, Math.max(0, similarity))) * BITS + 1e-9)

// ---------- videos: sequences of 4-word frame fingerprints ----------

const frameDistance = (a, ai, b, bi) => pair(a, ai * 4, b, bi * 4) + pair(a, ai * 4 + 2, b, bi * 4 + 2)

/** Mean distance between frames at the same relative positions. */
function framesDistance(a, b) {
  const n = Math.min(a.length, b.length) / 4
  if (!n) return BITS
  let total = 0
  for (let i = 0; i < n; i++) total += frameDistance(a, i, b, i)
  return total / n
}

/**
 * Where the shorter sequence best lines up inside the longer one: each frame is compared with
 * the nearest of its 3 neighbours in the longer video and the median distance is used (robust to
 * sampling offsets and motion). Returns { distance, offset } (offset in frames).
 */
function alignRobust(longer, shorter) {
  const L = longer.length / 4
  const S = shorter.length / 4
  if (!S || S > L) return { distance: BITS, offset: 0 }
  let best = BITS
  let bestOffset = 0
  const d = new Int32Array(S)
  for (let offset = 0; offset + S <= L; offset++) {
    for (let k = 0; k < S; k++) {
      const i = offset + k
      let v = frameDistance(longer, i, shorter, k)
      if (i + 1 < L) v = Math.min(v, frameDistance(longer, i + 1, shorter, k))
      if (i > 0) v = Math.min(v, frameDistance(longer, i - 1, shorter, k))
      d[k] = v
    }
    d.sort()
    const median = d[S >> 1]
    if (median < best) {
      best = median
      bestOffset = offset
    }
  }
  return { distance: best, offset: bestOffset }
}

/** Plain mean alignment (for the displayed similarity of a trimmed clip). */
function bestAlignment(longer, shorter) {
  const L = longer.length / 4
  const S = shorter.length / 4
  if (!S || S > L) return BITS
  let best = BITS
  for (let offset = 0; offset + S <= L; offset++) {
    let total = 0
    for (let k = 0; k < S && total / S < best; k++) total += frameDistance(longer, offset + k, shorter, k)
    if (total / S < best) best = total / S
  }
  return best
}

const toBase64 = (words) => Buffer.from(words.buffer, words.byteOffset, words.byteLength).toString('base64')
const fromBase64 = (s) => {
  const buf = Buffer.from(s, 'base64')
  const out = new Uint32Array(buf.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32LE(i * 4)
  return out
}

module.exports = {
  GRID,
  BITS,
  WORDS,
  ANALYSIS_SIZE,
  CROP_PENALTY,
  analyze,
  frameWords,
  compare,
  distance,
  isCropOf,
  maxDistanceFor,
  framesDistance,
  alignRobust,
  bestAlignment,
  resampleRegion,
  popcount,
  toBase64,
  fromBase64,
}
