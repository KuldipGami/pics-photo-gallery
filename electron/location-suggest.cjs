/**
 * Where was this taken? Suggests a location for photos and videos without one from what was shot
 * around the same time (time neighbours with a position, preferring the same folder and camera),
 * and finds towns by name in GeoNames' offline list (a places.cjs `Places`). Nothing is sent
 * anywhere.
 */

const HOUR = 3_600_000
const MINUTE = 60_000
const RAD = Math.PI / 180
const DEFAULT_WINDOW = 3 * HOUR

/** Has a usable position (0,0 is what broken GPS writes). */
const hasPosition = (it) => {
  const la = it?.meta?.lat
  const lo = it?.meta?.lon
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0)
}

/** Great-circle distance in km. */
function km(a, b) {
  const dLat = (b.lat - a.lat) * RAD
  const dLon = (b.lon - a.lon) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)))
}

const deviceOf = (it) => (it.meta?.model ? `${it.meta.make ?? ''}|${it.meta.model}`.toLowerCase() : null)

// Items with a position, sorted by date; rebuilt when the list changes.
const indexCache = new WeakMap()
function timeIndex(items) {
  let index = indexCache.get(items)
  if (!index) {
    index = items.filter(hasPosition).sort((a, b) => a.date - b.date)
    indexCache.set(items, index)
  }
  return index
}

/** First index in `sorted` whose date is ≥ ms. */
function lowerBound(sorted, ms) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].date < ms) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Candidate positions for one item: every located item taken within `window` of it, scored by
 * "effective gap" — the time between them, counted 1.5× for another folder, 1.25× for another
 * camera and 1.5× when either date is only a file date. Best first.
 */
function candidatesFor(target, index, window) {
  const out = []
  const t = target.date
  if (!Number.isFinite(t)) return out
  const device = deviceOf(target)
  const approx = target.taken == null
  for (let i = lowerBound(index, t - window); i < index.length && index[i].date <= t + window; i++) {
    const c = index[i]
    if (c.id === target.id) continue
    const gap = Math.abs(c.date - t)
    const sameFolder = c.dir === target.dir
    const otherDevice = device && deviceOf(c) && deviceOf(c) !== device
    const score = gap * (sameFolder ? 1 : 1.5) * (otherDevice ? 1.25 : 1) * (approx || c.taken == null ? 1.5 : 1)
    out.push({ item: c, gap, score, sameFolder, before: c.date <= t })
  }
  return out.sort((a, b) => a.score - b.score)
}

/** high: within half an hour, or between two photos taken close together · medium: within 2 h · low. */
function confidenceOf(best, cands, approx) {
  let level = best.score <= 30 * MINUTE ? 2 : best.score <= 2 * HOUR ? 1 : 0
  if (level < 2) {
    // taken between two photos that were shot close to each other: they didn't move in between
    const before = cands.find((c) => c.before)
    const after = cands.find((c) => !c.before)
    if (before && after && km(pos(before.item), pos(after.item)) < 2) level = Math.max(level, best.gap <= 2 * HOUR ? 2 : 1)
  }
  if (approx) level = Math.max(0, level - 1)
  return ['low', 'medium', 'high'][level]
}

const pos = (it) => ({ lat: it.meta.lat, lon: it.meta.lon })

/** { name, admin, country, cc, km } for a position (the town it belongs to), or null. */
function describe(places, lat, lon) {
  if (!places?.load?.() || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const i = places.lookup(lat, lon)
  if (i < 0) return null
  const d = places.data
  return {
    name: d.name[i],
    admin: d.admins[d.admin[i]] || '',
    country: d.countries[d.cc[i]] || d.cc[i],
    cc: d.cc[i],
    km: Math.round(km({ lat, lon }, { lat: d.lat[i], lon: d.lon[i] }) * 10) / 10,
    key: `g${i}`,
  }
}

/**
 * Suggestions for `targets` (items needing a location) from `items` (the whole library, with
 * user-set locations applied). Options: `window` (ms, default 3 h), `places` (a Places, to name
 * them). Returns {
 *   window,
 *   perItem: { [id]: { lat, lon, from, gap, confidence } }  — each target's best time neighbour,
 *   suggestions: [{ id, lat, lon, name, admin, country, cc, targets: [ids], sources: [ids],
 *                   gap (ms, smallest), confidence, alternative? }]  — grouped by town, most
 *                   targets first; `alternative`: no target's best match, but a candidate,
 *   missing: [ids]  — targets with nothing taken within the window
 * }
 */
function suggestLocations(targets, items, { window = DEFAULT_WINDOW, places = null } = {}) {
  const index = timeIndex(items)
  const perItem = {}
  const missing = []
  const groups = new Map()
  const groupByItem = new Map()
  const groupOf = (it) => {
    let g = groupByItem.get(it.id)
    if (g) return g
    const p = pos(it)
    const d = places ? describe(places, p.lat, p.lon) : null
    const place = d && d.km < 50 ? d : null
    // ~1 km cells out at sea or when no place names are available
    const key = place ? place.key : `${Math.round(p.lat * 100)},${Math.round(p.lon * 100)}`
    g = groups.get(key)
    if (!g) groups.set(key, (g = { key, place, best: null, targets: [], sources: new Map() }))
    groupByItem.set(it.id, g)
    return g
  }

  for (const target of targets) {
    const cands = candidatesFor(target, index, window)
    if (!cands.length) {
      missing.push(target.id)
      continue
    }
    const best = cands[0]
    const confidence = confidenceOf(best, cands, target.taken == null)
    perItem[target.id] = { ...pos(best.item), from: best.item.id, gap: best.gap, confidence }
    const g = groupOf(best.item)
    g.targets.push(target.id)
    // the group's position: its closest match; its sources: the photos that put it there
    if (!g.best || best.score < g.best.score) g.best = { ...best, confidence }
    g.sources.set(best.item.id, best.score)
    // other places nearby in time (e.g. travelling that day) are offered as alternatives
    for (const c of cands.slice(1, 40)) {
      const other = groupOf(c.item)
      if (other === g) {
        if (g.sources.size < 12) g.sources.set(c.item.id, Math.min(g.sources.get(c.item.id) ?? Infinity, c.score))
        continue
      }
      if (!other.best || c.score < other.best.score) other.best = { ...c, confidence: confidenceOf(c, cands, target.taken == null) }
      if (other.sources.size < 12) other.sources.set(c.item.id, Math.min(other.sources.get(c.item.id) ?? Infinity, c.score))
    }
  }

  const suggestions = [...groups.values()]
    .filter((g) => g.best)
    .map((g) => {
      const p = pos(g.best.item)
      const place = g.place ?? (places ? describe(places, p.lat, p.lon) : null)
      return {
        ...p,
        name: place?.name ?? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`,
        admin: place?.admin ?? '',
        country: place?.country ?? '',
        cc: place?.cc ?? '',
        targets: g.targets,
        sources: [...g.sources.entries()].sort((a, b) => a[1] - b[1]).slice(0, 8).map(([id]) => id),
        gap: g.best.gap,
        confidence: g.best.confidence,
        ...(g.targets.length ? {} : { alternative: true }),
      }
    })
    .sort((a, b) => b.targets.length - a.targets.length || a.gap - b.gap)
    .slice(0, 8)
    .map((s, n) => ({ ...s, id: `s${n}` }))

  return { window, perItem, suggestions, missing }
}

// ---------- place search ----------

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .toLowerCase()
    .trim()

// Folded names, built on the first search (~161k towns).
const foldCache = new WeakMap()
function folded(d) {
  let f = foldCache.get(d)
  if (!f) {
    f = {
      name: d.name.map(fold),
      admins: d.admins.map(fold),
      countries: Object.fromEntries(Object.entries(d.countries).map(([cc, n]) => [cc, fold(n)])),
    }
    foldCache.set(d, f)
  }
  return f
}

/** "48.8584, 2.2945", "48.8584 N 2.2945 E", "-33.86;151.21" → { lat, lon } or null. */
function parseCoordinates(text) {
  const m = String(text ?? '').match(
    /^\s*([+-]?\d{1,2}(?:[.,]\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*([+-]?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EW])?\s*$/i,
  )
  if (!m) return null
  const num = (s) => Number(s.replace(',', '.'))
  let lat = num(m[1])
  let lon = num(m[3])
  if (m[2]?.toUpperCase() === 'S') lat = -Math.abs(lat)
  if (m[4]?.toUpperCase() === 'W') lon = -Math.abs(lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

/**
 * Towns whose name matches `query`, best first: exact name, then name starting with it, then a
 * word in the name starting with it, then (3+ letters) containing it; bigger towns first within
 * each. "Springfield, Illinois" / "Paris, US" narrow by state or country (name or ISO code).
 * Coordinates ("48.85, 2.29") give that exact point. Accents and case are ignored.
 * Returns [{ name, admin, country, cc, lat, lon, pop, coordinates? }].
 */
function searchPlaces(places, query, limit = 8) {
  const coords = parseCoordinates(query)
  if (coords) {
    const d = describe(places, coords.lat, coords.lon)
    return [
      {
        name: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`,
        admin: d ? (d.km > 2 ? `Near ${d.name}` : d.name) : '',
        country: d?.country ?? '',
        cc: d?.cc ?? '',
        ...coords,
        pop: 0,
        coordinates: true,
      },
    ]
  }
  if (!places?.load?.()) return []
  const [first, ...rest] = String(query ?? '').split(',')
  const q = fold(first)
  if (q.length < 2) return []
  const quals = rest.map(fold).filter(Boolean)
  const d = places.data
  const f = folded(d)
  const n = f.name.length
  const hits = []
  for (let i = 0; i < n; i++) {
    const name = f.name[i]
    let rank
    if (name === q) rank = 0
    else if (name.startsWith(q)) rank = 1
    else {
      const at = name.indexOf(q)
      if (at < 0) continue
      if (/[\s\-(/]/.test(name[at - 1])) rank = 2
      else if (q.length >= 3) rank = 3
      else continue
    }
    if (quals.length) {
      const admin = f.admins[d.admin[i]] ?? ''
      const country = f.countries[d.cc[i]] ?? ''
      const cc = d.cc[i].toLowerCase()
      if (!quals.every((x) => admin.startsWith(x) || country.startsWith(x) || cc === x)) continue
    }
    hits.push(i * 4 + rank)
  }
  const rankOf = (h) => h & 3
  const idx = (h) => h >> 2
  hits.sort((a, b) => rankOf(a) - rankOf(b) || d.pop[idx(b)] - d.pop[idx(a)])
  const out = []
  const seen = new Set()
  for (const h of hits) {
    const i = idx(h)
    const place = {
      name: d.name[i],
      admin: d.admins[d.admin[i]] || '',
      country: d.countries[d.cc[i]] || d.cc[i],
      cc: d.cc[i],
      lat: d.lat[i],
      lon: d.lon[i],
      pop: d.pop[i],
    }
    // the same name twice in one state is usually a town and its district: keep the bigger one
    const key = `${place.name}|${place.admin}|${place.cc}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(place)
    if (out.length >= limit) break
  }
  return out
}

module.exports = { suggestLocations, searchPlaces, describe, parseCoordinates, hasPosition, km, DEFAULT_WINDOW }
