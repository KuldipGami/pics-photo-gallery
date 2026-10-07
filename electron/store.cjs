const fs = require('node:fs')
const path = require('node:path')

/** Tiny JSON-backed settings store with debounced, atomic writes. */
class Store {
  constructor(file, defaults) {
    this.file = file
    this.timer = null
    let saved = {}
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {}
    this.data = { ...defaults, ...saved }
  }

  get(key) {
    return this.data[key]
  }

  set(patch) {
    Object.assign(this.data, patch)
    this.saveSoon()
  }

  saveSoon() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), 300)
  }

  saveNow() {
    clearTimeout(this.timer)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('Failed to save settings', err)
    }
  }
}

module.exports = { Store }
