const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { idOf, keyOf } = require('./library.cjs')
const { writeAtomic, writeAtomicSync, serial, readJson } = require('./safe-file.cjs')

const newAlbumId = () => `a${crypto.randomBytes(5).toString('hex')}`
const cleanName = (name) => String(name ?? '').trim().slice(0, 80)
const albumsOf = (data) => (data?.version === 1 && Array.isArray(data.albums) ? data.albums.filter((a) => a && typeof a.id === 'string' && Array.isArray(a.paths)) : null)

/**
 * The user's albums (albums.json). Like favorites, members are stored by file path so the file
 * stays meaningful on its own; the UI works with item ids (derived from the path).
 *
 * Saving: one save at a time, each written to a temp file of its own and renamed over albums.json
 * (safe-file.cjs). A damaged albums.json is kept aside instead of being overwritten; one that can't
 * be read yet (locked) isn't saved over until it can be read and merged.
 */
class Albums extends EventEmitter {
  constructor(file) {
    super()
    this.file = file
    this.albums = [] // { id, name, paths: string[], cover: string | null, created, updated }
    this.timer = null
    this.loadError = null
    /** A save was asked for and hasn't started writing yet. */
    this.dirty = false
    this.writing = 0
    this.queue = serial(() => this.write())
  }

  async load() {
    const res = await readJson(this.file)
    if (res.data) this.albums = albumsOf(res.data) ?? []
    else if (res.corrupt) console.error(`albums.json was damaged; kept as ${res.keptAs ?? '(could not move it)'}`)
    else if (res.error) {
      this.loadError = res.error
      console.error("Couldn't read albums.json; it will be read again before saving", res.error)
    }
  }

  /** Reads albums.json again after it couldn't be read at start; its albums join this session's. */
  async retryLoad() {
    const res = await readJson(this.file)
    if (res.error) return false
    const saved = res.data ? albumsOf(res.data) : null
    if (saved?.length) {
      const known = new Set(this.albums.map((a) => a.id))
      this.albums.push(...saved.filter((a) => !known.has(a.id)))
      this.emit('changed')
    }
    this.loadError = null
    return true
  }

  serialize() {
    return JSON.stringify({ version: 1, albums: this.albums })
  }

  async write() {
    if (this.loadError && !(await this.retryLoad())) return
    this.dirty = false
    this.writing++
    try {
      await writeAtomic(this.file, this.serialize())
    } finally {
      this.writing--
    }
  }

  saveSoon() {
    clearTimeout(this.timer)
    this.dirty = true
    this.timer = setTimeout(() => this.save(), 500)
  }

  /** Saves after the current save (if any); resolves once the newest albums are written. */
  save() {
    clearTimeout(this.timer)
    this.timer = null
    this.dirty = true
    return this.queue().catch((err) => console.error('Failed to save albums', err))
  }

  /** At quit: saves what's waiting and resolves when it's written. */
  flush() {
    return this.dirty || this.writing ? this.save() : Promise.resolve()
  }

  /**
   * At quit, after flush() was awaited: writes what's still unsaved, at once. Does nothing while a
   * save is writing (an older version must never land after this one).
   */
  saveNow() {
    clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty || this.writing || this.loadError) return
    this.dirty = false
    try {
      writeAtomicSync(this.file, this.serialize())
    } catch (err) {
      console.error('Failed to save albums', err)
    }
  }

  changed() {
    this.saveSoon()
    this.emit('changed')
  }

  get(id) {
    return this.albums.find((a) => a.id === id)
  }

  snapshot() {
    return this.albums.map((a) => ({
      id: a.id,
      name: a.name,
      items: a.paths.map(idOf),
      ...(a.query ? { query: a.query } : {}),
      cover: a.cover ? idOf(a.cover) : null,
      created: a.created,
      updated: a.updated,
    }))
  }

  /** @param {{path: string}[]} items */
  create(name, items = []) {
    const now = Date.now()
    const album = { id: newAlbumId(), name: cleanName(name) || 'Untitled album', paths: [], cover: null, created: now, updated: now }
    this.albums.unshift(album)
    this.addTo(album, items)
    this.changed()
    return album.id
  }

  /** A smart album: a saved search; the app works out its photos live, so it holds no files. */
  createSmart(name, query) {
    const now = Date.now()
    const q = String(query ?? '').trim().slice(0, 200)
    const album = { id: newAlbumId(), name: cleanName(name) || cleanName(q) || 'Smart album', paths: [], query: q, cover: null, created: now, updated: now }
    this.albums.unshift(album)
    this.changed()
    return album.id
  }

  rename(id, name) {
    const album = this.get(id)
    const next = cleanName(name)
    if (!album || !next || next === album.name) return
    album.name = next
    album.updated = Date.now()
    this.changed()
  }

  remove(id) {
    const before = this.albums.length
    this.albums = this.albums.filter((a) => a.id !== id)
    if (this.albums.length !== before) this.changed()
  }

  addTo(album, items) {
    const known = new Set(album.paths.map(keyOf))
    let added = 0
    for (const it of items) {
      if (known.has(keyOf(it.path))) continue
      known.add(keyOf(it.path))
      album.paths.push(it.path)
      added++
    }
    if (added) album.updated = Date.now()
    return added
  }

  /** Returns how many were new to the album. */
  add(id, items) {
    const album = this.get(id)
    if (!album || album.query) return 0
    const added = this.addTo(album, items)
    if (added) this.changed()
    return added
  }

  removeItems(id, itemIds) {
    const album = this.get(id)
    if (!album) return
    const drop = new Set(itemIds)
    const before = album.paths.length
    album.paths = album.paths.filter((p) => !drop.has(idOf(p)))
    if (album.cover && drop.has(idOf(album.cover))) album.cover = null
    if (album.paths.length !== before) {
      album.updated = Date.now()
      this.changed()
    }
  }

  setCover(id, item) {
    const album = this.get(id)
    if (!album || (!album.query && !album.paths.some((p) => keyOf(p) === keyOf(item.path)))) return
    album.cover = item.path
    this.changed()
  }

  /** Files Lumen moved or renamed stay in their albums: old path → new path. */
  remapPaths(map) {
    let changed = false
    for (const album of this.albums) {
      album.paths = album.paths.map((p) => {
        const to = map.get(keyOf(p))
        if (!to) return p
        changed = true
        return to
      })
      if (album.cover && map.has(keyOf(album.cover))) album.cover = map.get(keyOf(album.cover))
    }
    if (changed) this.changed()
  }

  /**
   * Which albums hold these files, before they leave the library (so undoing a Clean up move can
   * put them back): [{ id, paths, cover? }]. Smart albums hold no files.
   */
  membershipsOf(paths) {
    const want = new Set((paths ?? []).filter((p) => typeof p === 'string').map(keyOf))
    const out = []
    if (!want.size) return out
    for (const album of this.albums) {
      if (album.query) continue
      const held = album.paths.filter((p) => want.has(keyOf(p)))
      const cover = album.cover && want.has(keyOf(album.cover)) ? album.cover : null
      if (held.length || cover) out.push({ id: album.id, paths: held, ...(cover && { cover }) })
    }
    return out
  }

  /**
   * Undo for forget(): the files of `paths` that are back go into the albums they were in
   * (`memberships` from membershipsOf), and get their cover back when the album has none. Albums
   * deleted since are left deleted. Returns true when an album changed.
   */
  restoreMemberships(memberships, paths) {
    const back = new Set((paths ?? []).filter((p) => typeof p === 'string').map(keyOf))
    let changed = false
    for (const m of Array.isArray(memberships) ? memberships : []) {
      const album = this.get(m?.id)
      if (!album || album.query) continue
      const known = new Set(album.paths.map(keyOf))
      for (const p of Array.isArray(m.paths) ? m.paths : []) {
        if (typeof p !== 'string' || !back.has(keyOf(p)) || known.has(keyOf(p))) continue
        album.paths.push(p)
        known.add(keyOf(p))
        album.updated = Date.now()
        changed = true
      }
      if (typeof m.cover === 'string' && !album.cover && back.has(keyOf(m.cover))) {
        album.cover = m.cover
        changed = true
      }
    }
    if (changed) this.changed()
    return changed
  }

  /** Files moved to the Recycle Bin leave every album. */
  forget(itemIds) {
    const drop = new Set(itemIds)
    let changed = false
    for (const album of this.albums) {
      const before = album.paths.length
      album.paths = album.paths.filter((p) => !drop.has(idOf(p)))
      if (album.cover && drop.has(idOf(album.cover))) album.cover = null
      if (album.paths.length !== before) changed = true
    }
    if (changed) this.changed()
  }
}

module.exports = { Albums }
