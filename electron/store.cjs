const { writeAtomicSync, readJsonSync } = require('./safe-file.cjs')

/**
 * Tiny JSON-backed settings store with debounced, atomic writes. A damaged settings.json is kept
 * aside (settings.json.damaged-<time>) and Lumen starts from the defaults; one that exists but
 * can't be read (still locked by another program) is never saved over during this session, so
 * the library folders listed in it aren't lost.
 */
class Store {
  constructor(file, defaults) {
    this.file = file
    this.timer = null
    this.readOnly = false
    let saved = {}
    const res = readJsonSync(file)
    if (res.data && typeof res.data === 'object' && !Array.isArray(res.data)) saved = res.data
    else if (res.corrupt) console.error(`settings.json was damaged; kept as ${res.keptAs ?? '(could not move it)'}`)
    else if (res.error) {
      console.error("Couldn't read settings.json; changes won't be saved this session", res.error)
      this.readOnly = true
    }
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
    this.timer = null
    if (this.readOnly) return
    try {
      writeAtomicSync(this.file, JSON.stringify(this.data, null, 2))
    } catch (err) {
      console.error('Failed to save settings', err)
    }
  }
}

module.exports = { Store }
