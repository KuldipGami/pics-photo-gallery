const fs = require('node:fs')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')

/**
 * Everything Lumen has done to files (history.json, newest first): moves, Recycle Bin, renames,
 * date fixes, edits, conversions. Entries that can be undone keep what's needed to put files back.
 *
 * Entry: { id, time, kind, destination?, note?, files: [{ from, to?, size, restored?, oldMtime? }],
 *          dateChanges?: [{ path, oldMtime, restored? }], movedOriginals?: [...files] }
 * kind: moved | recycled | copied | renamed | dates | edited | converted
 */
class History extends EventEmitter {
  constructor(file) {
    super()
    this.file = file
    this.entries = []
  }

  async load() {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      if (Array.isArray(data.entries)) this.entries = data.entries.sort((a, b) => b.time - a.time)
    } catch {}
  }

  async save() {
    try {
      const tmp = `${this.file}.tmp`
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, entries: this.entries }))
      await fsp.rename(tmp, this.file)
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
