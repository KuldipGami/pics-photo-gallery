// Groups faces into people. Runs in a worker thread (see FaceIndex.cluster).
//
// Density-based and incremental (the same idea Immich uses):
//  - a face with at least `minFaces - 1` close neighbours is a "core" face: it joins the person
//    most of its neighbours already belong to, or starts a new person;
//  - remaining faces join the person of their nearest close neighbour, if any.
// Faces that are already assigned keep their person, so user corrections are never undone, and a
// face is never put back into a person the user removed it from.
const { parentPort } = require('node:worker_threads')

// Faceprints are unit-length (ArcFace), so euclidean distance = sqrt(2 * cosine distance).
function cluster({ dims: DIMS = 512, desc, eligible, person, rejected, order, nextPerson, maxDist, minFaces }) {
  const max2 = maxDist * maxDist
  const candidates = []
  for (let i = 0; i < eligible.length; i++) if (eligible[i]) candidates.push(i)

  // Squared euclidean distance with early exit: almost all pairs are far apart.
  const dist2 = (a, b) => {
    let s = 0
    const oa = a * DIMS
    const ob = b * DIMS
    for (let k = 0; k < DIMS; k++) {
      const d = desc[oa + k] - desc[ob + k]
      s += d * d
      if (s >= max2) return s
    }
    return s
  }
  const neighbours = (i) => {
    const out = []
    for (const j of candidates) if (j !== i && dist2(i, j) < max2) out.push(j)
    return out
  }
  const isRejected = (i, p) => rejected[i] !== undefined && rejected[i].includes(p)

  // Running average faceprint per person. Joining a person also requires being close to their
  // average face, not just to one photo of them — this stops look-alikes from chaining together.
  const sums = new Map()
  const addToPerson = (i, p) => {
    person[i] = p
    let s = sums.get(p)
    if (!s) sums.set(p, (s = { v: new Float64Array(DIMS), n: 0 }))
    const o = i * DIMS
    for (let k = 0; k < DIMS; k++) s.v[k] += desc[o + k]
    s.n++
  }
  const nearCentroid = (i, p) => {
    const s = sums.get(p)
    if (!s) return true
    // compare with the average face's direction (the plain average of unit vectors is shorter)
    let dot = 0
    let norm = 0
    const o = i * DIMS
    for (let k = 0; k < DIMS; k++) {
      dot += desc[o + k] * s.v[k]
      norm += s.v[k] * s.v[k]
    }
    return 2 - (2 * dot) / (Math.sqrt(norm) || 1) < max2
  }
  for (let i = 0; i < person.length; i++) if (person[i] >= 0) addToPerson(i, person[i])

  const cache = new Map()
  for (const i of order) {
    if (!eligible[i] || person[i] >= 0) continue
    const near = neighbours(i)
    cache.set(i, near)
    if (near.length + 1 < minFaces) continue
    const votes = new Map()
    let refusedNear = 0
    for (const j of near) {
      const p = person[j]
      if (p < 0) continue
      if (isRejected(i, p)) refusedNear++
      else votes.set(p, (votes.get(p) || 0) + 1)
    }
    let best = -1
    let bestVotes = 0
    for (const [p, v] of votes) {
      if (v > bestVotes && nearCentroid(i, p)) {
        best = p
        bestVotes = v
      }
    }
    if (best >= 0) addToPerson(i, best)
    // A face the user took out of someone, still surrounded by that person's photos, stays
    // unassigned instead of becoming a look-alike "new" person. Anything else starts a new person
    // (if it's really someone already known, Combine fixes the split in one click).
    else if (refusedNear === 0) addToPerson(i, nextPerson++)
  }

  for (const i of order) {
    if (!eligible[i] || person[i] >= 0) continue
    const near = cache.get(i) ?? neighbours(i)
    let best = -1
    let bestDist = Infinity
    for (const j of near) {
      const p = person[j]
      if (p < 0 || isRejected(i, p) || !nearCentroid(i, p)) continue
      const d = dist2(i, j)
      if (d < bestDist) {
        bestDist = d
        best = p
      }
    }
    if (best >= 0) addToPerson(i, best)
  }
  return { person, nextPerson }
}

if (parentPort) {
  parentPort.on('message', (job) => {
    const result = cluster(job)
    parentPort.postMessage(result, [result.person.buffer])
  })
}
if (typeof module !== 'undefined') module.exports = { cluster }
