const fs = require('node:fs')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { idOf, keyOf } = require('./library.cjs')

const newAlbumId = () => `a${crypto.randomBytes(5).toString('hex')}`
const cleanName = (name) => String(name ?? '').trim().slice(0, 80)

/**
 * The user's albums (albums.json). Like favorites, members are stored by file path so the file
 * stays meaningful on its own; the UI works with item ids (derived from the path).
 */
class Albums extends EventEmitter {
  constructor(file) {
    super()
    this.file = file
    this.albums = [] // { id, name, paths: string[], cover: string | null, created, updated }
    this.timer = null
  }

  async load() {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      if (data.version === 1 && Array.isArray(data.albums)) this.albums = data.albums
    } catch {}
  }

  saveSoon() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.save(), 500)
  }

  async save() {
    clearTimeout(this.timer)
    this.timer = null
    try {
      const tmp = `${this.file}.tmp`
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, albums: this.albums }))
      await fsp.rename(tmp, this.file)
    } catch (err) {
      console.error('Failed to save albums', err)
    }
  }

  saveNow() {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, albums: this.albums }))
    } catch {}
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
    if (!album) return 0
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
    if (!album || !album.paths.some((p) => keyOf(p) === keyOf(item.path))) return
    album.cover = item.path
    this.changed()
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
