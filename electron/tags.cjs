const fsp = require('node:fs/promises')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { AsyncLocalStorage } = require('node:async_hooks')
const { idOf, keyOf } = require('./library.cjs')
const xmp = require('./xmp.cjs')
const { writeAtomic, writeAtomicSync, serial, readJson } = require('./safe-file.cjs')

const RATING = 1
const TAGS = 2
const RETRIES = 3

// Which hold() the running code is inside (a hold started from within one runs as part of it).
const holding = new AsyncLocalStorage()

/** A saved entry, checked: { path, edited, rating?, tags?, stamp?, dirty? } or null. */
function cleanEntry(e) {
  if (!e || typeof e.path !== 'string') return null
  const entry = { path: e.path, edited: Number(e.edited) || 0 }
  if (e.rating !== undefined) entry.rating = xmp.cleanRating(e.rating)
  if (Array.isArray(e.tags)) entry.tags = xmp.cleanTags(e.tags)
  if (Array.isArray(e.stamp) && e.stamp.length === 2) entry.stamp = e.stamp.map(Number)
  if (e.dirty) entry.dirty = e.dirty & (RATING | TAGS)
  return entry
}

/** An entry as plain JSON (without the writer's bookkeeping). */
const plainEntry = ({ gen, tries, ...e }) => JSON.parse(JSON.stringify(e))

/**
 * Star ratings and tags set in Pics (tags.json), keyed by file path like favorites and albums.
 * A library item carries what its file says (item.rating / item.tags, read during scans); a value
 * set here wins over the file's until the file changes on disk after Pics wrote it. JPEGs also get
 * the values written inside them (xmp.cjs), one file at a time in the background; other formats
 * stay in this store, plus an XMP sidecar when that setting is on.
 *
 * Events: 'changed' (snapshot), 'writing' (path) just before a file is rewritten,
 * 'written' ({ id, path, size, mtime, rating?, tags? }) after a photo was updated (its size
 * changed, its modified date didn't), 'write-error' ({ id, path, name, message }).
 */
class Tags extends EventEmitter {
  constructor(file, { writeFiles = true, sidecars = false } = {}) {
    super()
    this.file = file
    this.writeFiles = writeFiles
    this.sidecars = sidecars
    // key(path) → { path, rating?, tags?, edited, stamp?: [size, mtime], dirty?: RATING | TAGS }
    this.entries = new Map()
    this.timer = null
    this.queue = new Set()
    this.pumping = false
    this.holds = 0 // holds running or waiting their turn
    this.holdTail = Promise.resolve() // the last hold in line
    this.idleWaiters = []
    this.started = false
    // Saving: every change bumps `changes`; `saved` is the change count last written to tags.json.
    this.changes = 0
    this.saved = 0
    this.saving = null
    this.loadError = null // tags.json exists but couldn't be read: it is never written over this session
    this.writeOut = serial(async () => {
      const upTo = this.changes
      if (this.loadError || this.saved >= upTo) return
      await writeAtomic(this.file, this.serialize())
      this.saved = Math.max(this.saved, upTo)
    })
  }

  async load() {
    const res = await readJson(this.file)
    if (res.error) {
      this.loadError = res.error
      console.error("tags.json couldn't be read; it won't be saved over this session", res.error)
      return
    }
    if (res.corrupt) console.error('tags.json was damaged and has been kept as', res.keptAs)
    const data = res.data
    if (data === undefined) return // first run, or damaged (kept aside): start empty
    if (data?.version !== 1 || !Array.isArray(data.items)) {
      this.loadError = new Error('tags.json is in a format this version of Pics does not know')
      console.error(this.loadError.message)
      return
    }
    for (const e of data.items) {
      const entry = cleanEntry(e)
      if (entry) this.entries.set(keyOf(entry.path), entry)
    }
  }

  serialize() {
    return JSON.stringify({ version: 1, items: [...this.entries.values()].map(({ gen, tries, ...e }) => e) })
  }

  saveSoon() {
    this.changes++
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.save(), 500)
  }

  async save() {
    clearTimeout(this.timer)
    this.timer = null
    try {
      await (this.saving = this.writeOut())
    } catch (err) {
      console.error('Failed to save tags', err)
    }
  }

  /** On quit (sync). Pending file writes stay marked and are retried by resume() next time. */
  saveNow() {
    clearTimeout(this.timer)
    this.timer = null
    if (this.loadError || this.saved >= this.changes) return
    const upTo = this.changes
    try {
      writeAtomicSync(this.file, this.serialize())
      this.saved = upTo
    } catch (err) {
      console.error('Failed to save tags', err)
    }
  }

  changed() {
    this.saveSoon()
    this.emit('changed', this.snapshot())
  }

  /** Settings: write inside JPEGs (default on), XMP sidecars for other formats (default off). */
  configure({ writeFiles, sidecars } = {}) {
    if (writeFiles !== undefined) this.writeFiles = !!writeFiles
    if (sidecars !== undefined) this.sidecars = !!sidecars
  }

  /**
   * For the UI: { byItem: { [itemId]: { rating?, tags? } } } — only values set in Pics.
   * With `paths` (an array): the entries Pics holds for those files, as plain JSON, so they can
   * be put back with restoreEntries() (e.g. when a Clean up move that forgot them is undone).
   */
  snapshot(paths) {
    if (Array.isArray(paths)) {
      const out = []
      for (const p of paths) {
        const e = typeof p === 'string' ? this.entries.get(keyOf(p)) : null
        if (e) out.push(plainEntry(e))
      }
      return out
    }
    const byItem = {}
    for (const e of this.entries.values()) {
      const v = {}
      if (e.rating !== undefined) v.rating = e.rating
      if (e.tags !== undefined) v.tags = e.tags
      if (v.rating !== undefined || v.tags !== undefined) byItem[idOf(e.path)] = v
    }
    return { byItem }
  }

  /** What to show for a library item: Pics' value when set, else the file's. */
  valuesOf(item) {
    const e = this.entries.get(keyOf(item.path))
    return {
      rating: e?.rating ?? xmp.cleanRating(item.rating),
      tags: e?.tags ?? (Array.isArray(item.tags) ? item.tags : []),
    }
  }

  entryFor(item) {
    const key = keyOf(item.path)
    let e = this.entries.get(key)
    if (!e) this.entries.set(key, (e = { path: item.path, edited: 0 }))
    return e
  }

  mark(item, e, bit) {
    e.edited = Date.now()
    e.dirty = (e.dirty ?? 0) | bit
    e.gen = (e.gen ?? 0) + 1
    e.tries = 0
    this.queueWrite(keyOf(item.path))
  }

  /** Sets the star rating (0 clears) of library items. Returns how many changed. */
  setRating(items, rating) {
    const r = xmp.cleanRating(rating)
    let n = 0
    for (const it of items) {
      if (!it?.path || this.valuesOf(it).rating === r) continue
      const e = this.entryFor(it)
      e.rating = r
      this.mark(it, e, RATING)
      n++
    }
    if (n) this.changed()
    return n
  }

  /**
   * Adds and/or removes tags on library items: { add?: string[], remove?: string[] }, or
   * { set: string[] } to replace them. Tags already on an item keep their spelling. Returns how
   * many items changed.
   */
  editTags(items, { add = [], remove = [], set } = {}) {
    const adding = xmp.cleanTags(add)
    const dropping = new Set(xmp.cleanTags(remove).map((t) => t.toLowerCase()))
    let n = 0
    for (const it of items) {
      if (!it?.path) continue
      const current = this.valuesOf(it).tags
      const next = Array.isArray(set)
        ? xmp.cleanTags(set)
        : xmp.cleanTags([...current.filter((t) => !dropping.has(t.toLowerCase())), ...adding.filter((t) => !dropping.has(t.toLowerCase()))])
      if (xmp.sameTags(next, current)) continue
      const e = this.entryFor(it)
      e.tags = next
      this.mark(it, e, TAGS)
      n++
    }
    if (n) this.changed()
    return n
  }

  /** Every tag in use among `items` with how many items have it, most used first. */
  allTags(items) {
    const counts = new Map() // lower → { tag, count }
    for (const it of items) {
      for (const t of this.valuesOf(it).tags) {
        const k = t.toLowerCase()
        const c = counts.get(k)
        if (c) c.count++
        else counts.set(k, { tag: t, count: 1 })
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  /** Files Pics moved or renamed keep their rating and tags: Map(old key → new path). */
  remapPaths(map) {
    let changed = false
    for (const [key, e] of [...this.entries]) {
      const to = map.get(key)
      if (!to) continue
      this.entries.delete(key)
      this.queue.delete(key)
      e.path = to
      this.entries.set(keyOf(to), e)
      if (e.dirty) this.queueWrite(keyOf(to))
      changed = true
    }
    if (changed) this.changed()
  }

  /** Files that left the library (recycled / moved away by Pics). */
  forget(itemIds) {
    const drop = new Set(itemIds)
    let changed = false
    for (const [key, e] of [...this.entries]) {
      if (!drop.has(idOf(e.path))) continue
      this.entries.delete(key)
      this.queue.delete(key)
      changed = true
    }
    if (changed) this.changed()
  }

  /**
   * Puts back entries taken with snapshot(paths), keyed by their path (an entry set since for the
   * same file is kept when it is newer). Values not yet written into their file are queued again.
   * Returns how many were put back.
   */
  restoreEntries(entries) {
    let n = 0
    for (const raw of Array.isArray(entries) ? entries : []) {
      const e = cleanEntry(raw)
      if (!e) continue
      const key = keyOf(e.path)
      const current = this.entries.get(key)
      if (current && current.edited > e.edited) continue
      this.entries.set(key, e)
      if (e.dirty) this.queueWrite(key)
      n++
    }
    if (n) this.changed()
    return n
  }

  /**
   * Writes Pics' rating and tags into these files again (e.g. after History put an edited photo's
   * original back, which doesn't have them). Returns how many files were queued.
   */
  rewrite(paths) {
    let n = 0
    for (const p of Array.isArray(paths) ? paths : []) {
      const key = typeof p === 'string' ? keyOf(p) : null
      const e = key && this.entries.get(key)
      if (!e) continue
      const bits = (e.rating !== undefined ? RATING : 0) | (e.tags !== undefined ? TAGS : 0)
      if (!bits) continue
      e.dirty = (e.dirty ?? 0) | bits
      e.gen = (e.gen ?? 0) + 1
      e.tries = 0
      delete e.stamp // it described the file before; the next write records the new one
      this.queueWrite(key)
      n++
    }
    if (n) this.saveSoon()
    return n
  }

  /**
   * After a scan: a photo Pics wrote whose file changed since (Explorer, Lightroom…) goes back
   * to the file's values; one whose library item now shows the same values needs no entry.
   */
  reconcile(items) {
    let changed = false
    const byKey = new Map(items.map((it) => [keyOf(it.path), it]))
    for (const [key, e] of [...this.entries]) {
      if (!e.stamp || e.dirty) continue
      const it = byKey.get(key)
      if (!it) continue
      const moved = it.size !== e.stamp[0] || it.mtime !== e.stamp[1]
      const fileRating = xmp.cleanRating(it.rating)
      const fileTags = Array.isArray(it.tags) ? it.tags : []
      const same = (e.rating === undefined || e.rating === fileRating) && (e.tags === undefined || xmp.sameTags(e.tags, fileTags))
      if (moved || same) {
        this.entries.delete(key)
        changed = true
      }
    }
    if (changed) this.changed()
  }

  /** Drops entries whose files no longer exist (deleted outside Pics). */
  async prune(items) {
    const known = new Set(items.map((it) => keyOf(it.path)))
    let changed = false
    for (const [key, e] of [...this.entries]) {
      if (known.has(key)) continue
      try {
        await fsp.access(e.path)
      } catch (err) {
        if (err.code !== 'ENOENT') continue
        this.entries.delete(key)
        this.queue.delete(key)
        changed = true
      }
    }
    if (changed) this.changed()
  }

  // ── writing into files ──

  /** Starts writing (call once the library is loaded); also retries writes left from last time. */
  resume() {
    this.started = true
    for (const [key, e] of this.entries) if (e.dirty) this.queue.add(key)
    this.pump()
  }

  queueWrite(key) {
    this.queue.add(key)
    this.pump()
  }

  /**
   * Runs `fn` while no file is being written (e.g. Pics moving, rotating or re-dating photos),
   * then carries on. Held jobs run one at a time, in the order asked, each after the tag write in
   * progress (so two quick rotations never read the same old bytes). A hold asked for from inside a
   * running one runs straight away, as part of it. Resolves to fn's result.
   */
  async hold(fn) {
    const inside = holding.getStore()
    if (inside?.tags === this && inside.active) return fn()
    this.holds++
    const turn = this.holdTail.then(async () => {
      await this.current?.catch(() => {})
      const ctx = { tags: this, active: true }
      try {
        return await holding.run(ctx, fn)
      } finally {
        ctx.active = false
      }
    })
    this.holdTail = turn.catch(() => {})
    try {
      return await turn
    } finally {
      this.holds--
      this.pump()
      this.settleIdle()
    }
  }

  /**
   * Resolves once nothing is rewriting files any more: every queued tag write done, no held job
   * running or waiting, and the latest tags.json save finished (e.g. before quitting). Resolves
   * at once when that's already so. Writes still waiting to retry a busy file stay marked and are
   * done next time.
   */
  async flush() {
    if (!this.isIdle()) await new Promise((resolve) => this.idleWaiters.push(resolve))
    await this.saving?.catch(() => {})
  }

  isIdle() {
    return !this.holds && !this.pumping && (!this.started || !this.queue.size)
  }

  settleIdle() {
    if (this.isIdle()) for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  async pump() {
    if (this.pumping || !this.started) return
    this.pumping = true
    try {
      while (this.queue.size && !this.holds) {
        const key = this.queue.values().next().value
        this.queue.delete(key)
        this.current = this.writeOne(key)
        await this.current
      }
    } finally {
      this.current = null
      this.pumping = false
      this.settleIdle()
    }
  }

  async writeOne(key) {
    const e = this.entries.get(key)
    if (!e?.dirty) return
    const embed = this.writeFiles && xmp.canEmbed(e.path)
    if (!embed && !this.sidecars) {
      e.dirty = 0 // kept in Pics only
      this.saveSoon()
      return
    }
    const gen = e.gen
    const fields = {}
    if (e.dirty & RATING) fields.rating = e.rating ?? 0
    if (e.dirty & TAGS) fields.tags = e.tags ?? []
    this.emit('writing', e.path)
    const res = embed ? await xmp.writeJpeg(e.path, fields) : await xmp.writeSidecar(e.path, fields)
    if (this.entries.get(key) !== e) return // moved or forgotten meanwhile (remapPaths re-queues)
    if (res.ok) {
      if (e.gen === gen) e.dirty = 0
      else this.queue.add(key) // changed again while writing
      if (embed) {
        e.stamp = [res.size, res.mtime]
        this.emit('written', { id: idOf(e.path), path: e.path, size: res.size, mtime: res.mtime, ...fields })
      }
      this.saveSoon()
      return
    }
    if (res.busy && (e.tries = (e.tries ?? 0) + 1) < RETRIES) {
      setTimeout(() => this.queueWrite(key), 4000 * e.tries) // open in another program: try again shortly
      return
    }
    // Gone (moved or deleted outside Pics): nothing to report. Otherwise Pics keeps the value.
    e.dirty = 0
    if (!/ENOENT|no such file/i.test(res.error ?? '')) this.emit('write-error', { id: idOf(e.path), path: e.path, name: path.basename(e.path), message: res.error })
    this.saveSoon()
  }
}

module.exports = { Tags }
