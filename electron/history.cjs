const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { writeAtomic, writeAtomicSync, serial, readJson } = require('./safe-file.cjs')

/**
 * Everything Pics has done to files (history.json, newest first): moves, Recycle Bin, renames,
 * date fixes, edits, conversions. Entries that can be undone keep what's needed to put files back.
 *
 * Entry: { id, time, kind, destination?, note?, files: [{ from, to?, size, restored?, oldMtime?, sidecar? }],
 *          dateChanges?: [{ path, oldMtime, restored? }], movedOriginals?: [...files], forgotten? }
 * kind: moved | recycled | copied | renamed | dates | edited | converted | imported
 *
 * Saving: one save at a time, each to a temp file of its own that is then renamed over history.json
 * (safe-file.cjs). A damaged history.json is kept aside instead of being overwritten by the next
 * save; one that can't be read yet (locked) isn't saved over until it can be read and merged.
 */

const keyOf = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p))

/**
 * Which side of an entry's file records names where the file is now (until it's undone):
 * an edit's or date fix's photo (`from`; an edit's `to` is its backup), a move's, rename's, copy's
 * or import's destination (`to`), and both for a conversion (the HEIC stays when kept in place).
 * A recycled file isn't anywhere Pics could follow.
 */
const LIVE = {
  edited: ['from'],
  dates: ['from'],
  moved: ['to'],
  renamed: ['to'],
  copied: ['to'],
  imported: ['to'],
  converted: ['from', 'to'],
}

const entriesOf = (data) =>
  Array.isArray(data?.entries) ? data.entries.filter((e) => e && typeof e === 'object' && typeof e.id === 'string').sort((a, b) => b.time - a.time) : []

class History extends EventEmitter {
  constructor(file) {
    super()
    this.file = file
    this.entries = []
    /** history.json exists but couldn't be read at start: it isn't saved over until it can be. */
    this.loadError = null
    /** A save was asked for and hasn't started writing yet. */
    this.dirty = false
    this.writing = 0
    this.queue = serial(() => this.write())
  }

  async load() {
    const res = await readJson(this.file)
    if (res.data) this.entries = entriesOf(res.data)
    else if (res.corrupt) console.error(`history.json was damaged; kept as ${res.keptAs ?? '(could not move it)'}`)
    else if (res.error) {
      this.loadError = res.error
      console.error("Couldn't read history.json; it will be read again before saving", res.error)
    }
  }

  /** Reads history.json again after it couldn't be read at start; its entries join this session's. */
  async retryLoad() {
    const res = await readJson(this.file)
    if (res.error) return false
    if (res.data) {
      const known = new Set(this.entries.map((e) => e.id))
      for (const e of entriesOf(res.data)) if (!known.has(e.id)) this.entries.push(e)
      this.entries.sort((a, b) => b.time - a.time)
      this.emit('changed')
    }
    this.loadError = null
    return true
  }

  serialize() {
    return JSON.stringify({ version: 1, entries: this.entries })
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

  /** Saves soon after the current save (if any); resolves once the newest entries are written. */
  save() {
    this.dirty = true
    return this.queue().catch((err) => console.error('Failed to save history', err))
  }

  /** At quit: resolves once what's waiting is written (at once when nothing is). */
  flush() {
    return this.dirty || this.writing ? this.save() : Promise.resolve()
  }

  /**
   * At quit, after flush() was awaited: writes what's still unsaved, at once. Does nothing while a
   * save is writing (an older version must never land after this one).
   */
  saveNow() {
    if (!this.dirty || this.writing || this.loadError) return
    this.dirty = false
    try {
      writeAtomicSync(this.file, this.serialize())
    } catch (err) {
      console.error('Failed to save history', err)
    }
  }

  add(entry) {
    const full = { id: crypto.randomBytes(6).toString('hex'), time: Date.now(), files: [], ...entry }
    this.entries.unshift(full)
    this.save()
    this.emit('changed')
    return full
  }

  get(id) {
    return this.entries.find((e) => e.id === id)
  }

  changed(entry) {
    if (entry) this.save()
    this.emit('changed')
  }

  /**
   * Files Pics moved or renamed since ([{ from, to, sidecar?: { from, to } }]): entries that still
   * point at a file's old path follow it, so undoing an older edit, date fix or move acts on the
   * file where it is now, not on whatever took its old place. Only the side of a record that names
   * where the file is now changes (LIVE), and records already undone are left alone. Returns how
   * many paths changed.
   */
  remapPaths(pairs) {
    const map = new Map()
    const note = (from, to) => {
      if (typeof from === 'string' && typeof to === 'string' && from && to && keyOf(from) !== keyOf(to)) map.set(keyOf(from), to)
    }
    for (const p of pairs ?? []) {
      note(p?.from, p?.to)
      note(p?.sidecar?.from, p?.sidecar?.to)
    }
    if (!map.size) return 0
    let n = 0
    const follow = (record, field) => {
      const to = typeof record?.[field] === 'string' ? map.get(keyOf(record[field])) : undefined
      if (!to) return
      record[field] = to
      n++
    }
    for (const entry of this.entries) {
      const sides = LIVE[entry.kind] ?? []
      for (const f of entry.files ?? []) {
        if (!f || f.restored) continue
        for (const side of sides) {
          follow(f, side)
          if (f.sidecar && typeof f.sidecar === 'object') follow(f.sidecar, side)
        }
      }
      for (const c of entry.dateChanges ?? []) if (c && !c.restored) follow(c, 'path')
    }
    if (n) {
      this.save()
      this.emit('changed')
    }
    return n
  }

  async clear() {
    this.entries = []
    await this.save()
    this.emit('changed')
  }

  list() {
    return this.entries
  }
}

module.exports = { History }
