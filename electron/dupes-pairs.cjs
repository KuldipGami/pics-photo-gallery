// Worker thread: finds every pair of pictures whose fingerprints (see signature.cjs) are within
// the match threshold, in any of the 8 orientations, or — with crops on — as a centre crop.
// Brute force over all pairs, split across several workers (rows i ≡ start mod step).
// Self-contained (no require): main runs it with `eval`, which also works inside app.asar.
const { parentPort } = require('node:worker_threads')

function popcount(n) {
  n -= (n >>> 1) & 0x55555555
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

parentPort.once('message', ({ words, crops, n, maxDist, findCrops, start, step }) => {
  const W = words
  const cropLimit = maxDist - 3 // crop distance + penalty (3) must stay within the threshold
  const pairs = []
  for (let i = start; i < n; i += step) {
    const a = i * 48
    const aH0 = W[a]
    const aH1 = W[a + 1]
    const aV0 = W[a + 16]
    const aV1 = W[a + 17]
    const aCrops = findCrops && cropLimit >= 0 && crops[i] === 1
    for (let j = i + 1; j < n; j++) {
      const b = j * 48
      let hit = false
      for (let r = 0; r < 8 && !hit; r++) {
        const dh = popcount(aH0 ^ W[b + r * 2]) + popcount(aH1 ^ W[b + r * 2 + 1])
        if (dh > maxDist) continue
        if (dh + popcount(aV0 ^ W[b + 16 + r * 2]) + popcount(aV1 ^ W[b + 17 + r * 2]) <= maxDist) hit = true
      }
      if (!hit && aCrops && crops[j] === 1) {
        const bH0 = W[b]
        const bH1 = W[b + 1]
        const bV0 = W[b + 16]
        const bV1 = W[b + 17]
        for (let k = 0; k < 4 && !hit; k++) {
          const d1 =
            popcount(W[a + 32 + k * 2] ^ bH0) + popcount(W[a + 33 + k * 2] ^ bH1) +
            popcount(W[a + 40 + k * 2] ^ bV0) + popcount(W[a + 41 + k * 2] ^ bV1)
          const d2 =
            popcount(aH0 ^ W[b + 32 + k * 2]) + popcount(aH1 ^ W[b + 33 + k * 2]) +
            popcount(aV0 ^ W[b + 40 + k * 2]) + popcount(aV1 ^ W[b + 41 + k * 2])
          if (Math.min(d1, d2) <= cropLimit) hit = true
        }
      }
      if (hit) pairs.push(i, j)
    }
  }
  const out = Int32Array.from(pairs)
  parentPort.postMessage(out, [out.buffer])
})
