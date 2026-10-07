const fs = require('node:fs')
const zlib = require('node:zlib')

const CELL = 1 // degrees per lookup cell (~111 km): the 3×3 cells around a photo cover any town
const RAD = Math.PI / 180

/**
 * Offline reverse geocoding: turns a photo's GPS position into a town, state and country using
 * GeoNames' list of every place with 1,000+ inhabitants (models/places.json.gz). Nothing is sent
 * anywhere.
 *
 * A photo belongs to the place that "covers" it best: bigger places reach further (radius grows
 * with population), so a photo in a city's suburb is filed under that city rather than under the
 * nearest village, while a separate town next door still gets its own name.
 */
class Places {
  constructor(file) {
    this.file = file
    this.data = null
    this.grid = null
    this.failed = false
  }

  get available() {
    return !this.failed && fs.existsSync(this.file)
  }

  load() {
    if (this.data || this.failed) return !!this.data
    try {
      const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(this.file)).toString('utf8'))
      const n = d.name.length
      const lat = new Float64Array(n)
      const lon = new Float64Array(n)
      const reach = new Float64Array(n)
      const grid = new Map()
      for (let i = 0; i < n; i++) {
        lat[i] = d.lat[i] / 1e4
        lon[i] = d.lon[i] / 1e4
        // 1.5 km for a village of 1,000 · ~10 km for 100k · ~24 km for 1M · ~60 km for 10M
        reach[i] = 1.5 * Math.pow(Math.max(d.pop[i], 1000) / 1000, 0.4)
        const key = `${Math.floor(lat[i] / CELL)},${Math.floor(lon[i] / CELL)}`
        let cell = grid.get(key)
        if (!cell) grid.set(key, (cell = []))
        cell.push(i)
      }
      this.data = { ...d, lat, lon, reach }
      this.grid = grid
      return true
    } catch (err) {
      console.error('[places] could not load place names', err)
      this.failed = true
      return false
    }
  }

  /** Index of the place a position belongs to, or -1 (e.g. out at sea). */
  lookup(la, lo) {
    const { lat, lon, reach } = this.data
    const cy = Math.floor(la / CELL)
    const cx = Math.floor(lo / CELL)
    const cosLat = Math.cos(la * RAD)
    let best = -1
    let bestScore = Infinity
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        let x = cx + dx
        if (x < -180) x += 360
        else if (x > 179) x -= 360
        const cell = this.grid.get(`${cy + dy},${x}`)
        if (!cell) continue
        for (const i of cell) {
          let dLon = Math.abs(lon[i] - lo)
          if (dLon > 180) dLon = 360 - dLon
          const km = 111.2 * Math.hypot(lat[i] - la, dLon * cosLat)
          const score = km / reach[i]
          if (score < bestScore) {
            bestScore = score
            best = i
          }
        }
      }
    }
    return best
  }

  /**
   * Groups items with a GPS position by place. Returns every place with its photo count and cover
   * (newest photo), plus item id → place id.
   */
  group(items) {
    if (!this.load()) return { places: [], byItem: {} }
    const d = this.data
    const byItem = {}
    const stats = new Map()
    for (const it of items) {
      const la = it.meta?.lat
      const lo = it.meta?.lon
      if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0) || Math.abs(la) > 90) continue
      const i = this.lookup(la, lo)
      if (i < 0) continue
      const id = `g${i}`
      byItem[it.id] = id
      let s = stats.get(id)
      if (!s) stats.set(id, (s = { i, count: 0, cover: it }))
      s.count++
      // newest photo as the cover (a video only if there are no photos)
      const better = (a, b) => (a.type === 'image') !== (b.type === 'image') ? a.type === 'image' : a.date > b.date
      if (better(it, s.cover)) s.cover = it
    }
    const places = [...stats.entries()]
      .map(([id, s]) => ({
        id,
        name: d.name[s.i],
        admin: d.admins[d.admin[s.i]] || '',
        country: d.countries[d.cc[s.i]] || d.cc[s.i],
        cc: d.cc[s.i],
        lat: d.lat[s.i],
        lon: d.lon[s.i],
        count: s.count,
        cover: s.cover.id,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return { places, byItem }
  }
}

module.exports = { Places }
