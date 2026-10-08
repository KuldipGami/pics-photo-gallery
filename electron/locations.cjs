const fsp = require('node:fs/promises')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { isJpeg, validGps } = require('./jpeg-exif.cjs')
const edits = require('./edits.cjs')

/**
 * Locations the user gave to photos and videos whose files can't take one without being re-saved
 * (HEIC, PNG, videos…), and JPEGs that had no room for it. Kept in locations.json (userData),
 * keyed by file path, and laid over the library's own metadata by apply(), so they survive
 * rescans. JPEGs normally get the position written into the file itself (edits.setLocation).
 *
 * File: { version: 1, items: [{ path, lat, lon, at }] }
 */

const keyOf = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p))
const round = (v) => Math.round(v * 1e7) / 1e7 // ~1 cm

class Locations extends EventEmitter {
  constructor(file) {
    super()
    this.file = file
    /** key(path) → { path, lat, lon, at } */
    this.map = new Map()
    /** Bumped on every change (apply() caches on it). */
    this.version = 0
    this.cache = null
    this.timer = null
  }

  async load() {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      if (data.version === 1 && Array.isArray(data.items)) {
        for (const e of data.items) {
          const gps = validGps(e)
          if (gps && typeof e.path === 'string') this.map.set(keyOf(e.path), { path: e.path, ...gps, at: Number(e.at) || 0 })
        }
        this.version++
      }
    } catch {}
  }

  async save() {
    clearTimeout(this.timer)
    this.timer = null
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, items: [...this.map.values()] }))
      await fsp.rename(tmp, this.file)
    } catch (err) {
      console.error('Failed to save locations', err)
    }
  }

  saveSoon() {
    if (!this.timer) this.timer = setTimeout(() => this.save(), 500)
  }

  changed() {
    this.version++
    this.saveSoon()
    this.emit('changed')
  }

  get size() {
    return this.map.size
  }

  /** The location Lumen keeps for this file, or null. */
  get(file) {
    const e = this.map.get(keyOf(file))
    return e ? { lat: e.lat, lon: e.lon } : null
  }

  /** Remembers a location for a file. Returns the one it replaced (or null). */
  set(file, location, { silent = false } = {}) {
    const gps = validGps(location)
    if (!gps) return null
    const prev = this.get(file)
    this.map.set(keyOf(file), { path: file, lat: round(gps.lat), lon: round(gps.lon), at: Date.now() })
    if (!silent) this.changed()
    return prev
  }

  /** Forgets a file's location. Returns the one it had (or null). */
  remove(file, { silent = false } = {}) {
    const prev = this.get(file)
    if (prev) {
      this.map.delete(keyOf(file))
      if (!silent) this.changed()
    }
    return prev
  }

  /**
   * Library items with the remembered locations laid over their metadata (copies; the library's
   * own items are left untouched, so its cache never holds them). Such items get
   * `meta.userLocation: true`. Returns `list` itself when nothing applies; cached per list.
   */
  apply(list) {
    if (!this.map.size) return list
    if (this.cache?.list === list && this.cache.version === this.version) return this.cache.out
    let hit = false
    const out = list.map((it) => {
      const e = this.map.get(keyOf(it.path))
      if (!e) return it
      hit = true
      return { ...it, meta: { ...it.meta, lat: e.lat, lon: e.lon, userLocation: true } }
    })
    const result = hit ? out : list
    this.cache = { list, version: this.version, out: result }
    return result
  }

  /** Files Lumen moved or renamed ([{ from, to }]): their locations go with them. */
  remap(pairs) {
    let n = 0
    for (const { from, to } of pairs ?? []) {
      const e = from && to ? this.map.get(keyOf(from)) : null
      if (!e) continue
      this.map.delete(keyOf(from))
      this.map.set(keyOf(to), { ...e, path: to })
      n++
    }
    if (n) this.changed()
    return n
  }

  /**
   * Undo (History) for the records assign() made. Call after edits.restoreBackups(entry.files):
   * Lumen-only records ({ from, prev }) get their previous location back (or none); a JPEG that
   * was restored from its backup gets back the Lumen-only location it had before (`prevStored`).
   * Marks records `restored`; returns how many locations changed.
   */
  revert(files) {
    let n = 0
    for (const f of files ?? []) {
      if (!f?.from) continue
      if (f.to) {
        // a JPEG backup (edits.restoreBackups put the file back)
        if (f.restored && f.prevStored) {
          this.set(f.from, f.prevStored, { silent: true })
          f.prevStored = null
          n++
        }
        continue
      }
      if (f.restored || !('prev' in f)) continue
      if (f.prev) this.set(f.from, f.prev, { silent: true })
      else this.remove(f.from, { silent: true })
      f.restored = true
      n++
    }
    if (n) this.changed()
    return n
  }
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

/**
 * Gives items a location. JPEGs get it written into the file (lossless, backed up, undoable from
 * History); other files — and JPEGs that can't take it without re-saving — get a Lumen-only
 * location in `store`. `targets`: [{ item, lat, lon }]. With `writeFiles: false` nothing on disk
 * changes (every location is kept by Lumen).
 *
 * Resolves {
 *   files:   records for one History entry (kind 'edited'): JPEG backups { from, to, size, oldMtime,
 *            location, prevStored } and Lumen-only records { from, location, prev },
 *   written: [{ id, path, size, lat, lon }]  JPEGs changed on disk (update the library entry),
 *   stored:  [id]                             items now located by Lumen only,
 *   kept:    [{ name, reason }]               JPEGs that couldn't be changed (kept by Lumen instead),
 *   errors:  [string]
 * }
 */
async function assignLocations(targets, { store, backupsDir, writeFiles = true, setLocation = edits.setLocation } = {}) {
  const files = []
  const written = []
  const stored = []
  const kept = []
  const errors = []
  for (const t of targets ?? []) {
    const item = t?.item
    const gps = validGps(t)
    if (!item || !gps) {
      if (item) errors.push(`${item.name}: the location isn't valid.`)
      continue
    }
    const location = { lat: round(gps.lat), lon: round(gps.lon) }
    if (writeFiles && isJpeg(item.ext || item.path)) {
      const res = await setLocation(item, location, backupsDir)
      if (!res.error) {
        // the file holds it now: a location Lumen kept for it before would hide the new one
        const prevStored = store.remove(item.path, { silent: true })
        files.push({ ...res.file, location, prevStored })
        written.push({ id: item.id, path: item.path, size: res.size, ...location })
        continue
      }
      kept.push({ name: item.name, reason: res.error })
    }
    const prev = store.set(item.path, location, { silent: true })
    files.push({ from: item.path, location, prev })
    stored.push(item.id)
  }
  if (files.length) store.changed()
  return { files, written, stored, kept, errors }
}

/** "Location of IMG_1.jpg set to Paris, France" / "Added a location to 12 photos (Paris, France)". */
function historyNote(targets, label) {
  const list = targets ?? []
  const where = label ? ` to ${label}` : ''
  if (list.length === 1) return `Location of ${list[0].item?.name ?? 'a photo'} set${where}`
  const videos = list.filter((t) => t.item?.type === 'video').length
  const what = videos === list.length ? plural(list.length, 'video') : videos ? plural(list.length, 'item') : plural(list.length, 'photo')
  return `Location of ${what} set${where}`
}

module.exports = { Locations, assignLocations, historyNote }
