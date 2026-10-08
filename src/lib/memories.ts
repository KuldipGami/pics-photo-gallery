import type { MediaItem, Memory, Place, PlacesData, Trip } from '../types'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const TRIP_GAP = 2 * DAY // more than this without an away-from-home photo ends a trip
const HOME_KM = 60 // within this of a home base counts as home
const MIN_TRIP_PHOTOS = 6
const RAD = Math.PI / 180

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * RAD)
  return 111.2 * Math.hypot(b.lat - a.lat, x)
}

const monthKey = (ts: number) => {
  const d = new Date(ts)
  return d.getFullYear() * 12 + d.getMonth()
}

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const shortDateYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

/** "Dec 20 – 27, 2023", "Dec 30, 2023 – Jan 2, 2024", "Mar 3, 2024" */
export function formatTripDates(start: number, end: number) {
  const a = new Date(start)
  const b = new Date(end)
  if (a.toDateString() === b.toDateString()) return shortDateYear.format(a)
  if (a.getFullYear() === b.getFullYear()) {
    if (a.getMonth() === b.getMonth()) return `${shortDate.format(a)} – ${b.getDate()}, ${b.getFullYear()}`
    return `${shortDate.format(a)} – ${shortDateYear.format(b)}`
  }
  return `${shortDateYear.format(a)} – ${shortDateYear.format(b)}`
}

/**
 * Trips: runs of photos taken away from home, worked out from where (GPS → place) and when.
 * Home bases are places you keep coming back to (photos in many different months); there can be
 * several (e.g. where you study and where your family lives). Photos without a position that were
 * taken during a trip, in the same folders as its photos, belong to it too.
 */
export function findTrips(items: MediaItem[], places: PlacesData): Trip[] {
  const placeById = new Map(places.places.map((p) => [p.id, p]))
  const located = items
    .filter((it) => places.byItem[it.id] && Number.isFinite(it.meta?.lat))
    .sort((a, b) => a.date - b.date)
  if (located.length < MIN_TRIP_PHOTOS) return []

  // home bases: places with photos in 4+ different months, plus the single busiest place
  const months = new Map<string, Set<number>>()
  for (const it of located) {
    const pid = places.byItem[it.id]
    let set = months.get(pid)
    if (!set) months.set(pid, (set = new Set()))
    set.add(monthKey(it.date))
  }
  const homes: Place[] = []
  for (const [pid, set] of months) if (set.size >= 4) homes.push(placeById.get(pid)!)
  const busiest = places.places[0]
  if (busiest && !homes.includes(busiest)) homes.push(busiest)
  const atHome = (it: MediaItem) => homes.some((h) => km(h, { lat: it.meta!.lat!, lon: it.meta!.lon! }) < HOME_KM)
  const homeCountries = new Set(homes.map((h) => h.cc))

  // group away-from-home photos into runs
  const runs: MediaItem[][] = []
  let run: MediaItem[] = []
  for (const it of located) {
    if (atHome(it)) continue
    if (run.length && it.date - run[run.length - 1].date > TRIP_GAP) {
      runs.push(run)
      run = []
    }
    run.push(it)
  }
  if (run.length) runs.push(run)

  const byDate = [...items].sort((a, b) => a.date - b.date)
  const trips: Trip[] = []
  for (const r of runs) {
    const start = r[0].date
    const end = r[r.length - 1].date
    const days = Math.round((end - start) / DAY)
    if (r.length < MIN_TRIP_PHOTOS && days < 1) continue
    // add photos without a position from the same folders, taken during the trip
    const folders = new Set(r.map((it) => it.dir))
    const ids = new Set(r.map((it) => it.id))
    for (const it of byDate) {
      if (it.date < start - 6 * HOUR) continue
      if (it.date > end + 6 * HOUR) break
      if (!places.byItem[it.id] && folders.has(it.dir)) ids.add(it.id)
    }

    // name: the main town, else the state, else the country, else the two main towns
    const count = new Map<string, number>()
    for (const it of r) count.set(places.byItem[it.id], (count.get(places.byItem[it.id]) ?? 0) + 1)
    const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([pid]) => placeById.get(pid)!)
    const main = ranked[0]
    const admins = new Set(ranked.map((p) => `${p.cc}|${p.admin}`))
    const countries = new Set(ranked.map((p) => p.cc))
    let title: string
    let where: string
    if ((count.get(main.id) ?? 0) / r.length >= 0.6 || ranked.length === 1) {
      title = main.name
      where = [main.admin, main.country].filter(Boolean).join(', ')
    } else if (admins.size === 1 && main.admin) {
      title = main.admin
      where = main.country
    } else if (countries.size === 1 && !homeCountries.has(main.cc)) {
      title = main.country
      where = ranked
        .slice(0, 3)
        .map((p) => p.name)
        .join(', ')
    } else {
      title = ranked.length > 2 ? `${ranked[0].name}, ${ranked[1].name} & more` : `${ranked[0].name} & ${ranked[1].name}`
      where = [...new Set(ranked.map((p) => p.country))].join(', ')
    }

    // cover: a photo from the main town, from the middle of the stay
    const atMain = r.filter((it) => it.type === 'image' && places.byItem[it.id] === main.id)
    const pool = atMain.length ? atMain : r
    const cover = pool[Math.floor(pool.length / 2)]
    trips.push({ id: `t${start.toString(36)}`, title, where, start, end, items: [...ids], cover: cover.id })
  }
  return trips.sort((a, b) => b.start - a.start)
}

/**
 * The trip that an earlier one became: the one sharing the most photos with it. A trip's id comes
 * from its first located photo, so deleting that photo (or locating an earlier one) gives it a new id.
 */
export function matchTrip(old: Trip, trips: Trip[]): Trip | undefined {
  const ids = new Set(old.items)
  let best: Trip | undefined
  let bestCount = 0
  for (const t of trips) {
    let n = 0
    for (const id of t.items) if (ids.has(id)) n++
    if (n > bestCount) {
      best = t
      bestCount = n
    }
  }
  return best
}

/**
 * "On this day": photos from today's date in earlier years (or from this week, on days with none),
 * one memory per year, newest first.
 */
export function onThisDay(items: MediaItem[], now = Date.now()): Memory[] {
  const today = new Date(now)
  const year = today.getFullYear()
  const todayDay = Date.UTC(year, today.getMonth(), today.getDate())
  // Each returns how many years ago a photo's date was "today" (0 = not a match).
  const sameDay = (d: Date) => (d.getMonth() === today.getMonth() && d.getDate() === today.getDate() ? year - d.getFullYear() : 0)
  // Within 3 days of today's date, also across New Year (Dec 30 on Jan 1). Calendar days in UTC,
  // so a DST change in between doesn't count.
  const nearDay = (d: Date) => {
    for (const y of [year, year - 1, year + 1]) {
      if (Math.abs(Math.round((Date.UTC(y, d.getMonth(), d.getDate()) - todayDay) / DAY)) <= 3) return y - d.getFullYear()
    }
    return 0
  }
  for (const match of [sameDay, nearDay]) {
    const byAgo = new Map<number, MediaItem[]>()
    for (const it of items) {
      const ago = match(new Date(it.date))
      if (ago < 1) continue
      let list = byAgo.get(ago)
      if (!list) byAgo.set(ago, (list = []))
      list.push(it)
    }
    if (!byAgo.size) continue
    return [...byAgo.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ago, list]) => {
        list.sort((a, b) => a.date - b.date)
        const photos = list.filter((it) => it.type === 'image')
        const cover = (photos.length ? photos : list)[Math.floor((photos.length ? photos : list).length / 2)]
        return {
          label: `${ago} year${ago === 1 ? '' : 's'} ago${match === nearDay ? ' this week' : ''}`,
          year: new Date(list[0].date).getFullYear(),
          date: list[0].date,
          items: list.map((it) => it.id),
          cover: cover.id,
        }
      })
  }
  return []
}

export const formatMonthYear = (ts: number) => monthYear.format(ts)
