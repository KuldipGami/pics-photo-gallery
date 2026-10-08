const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const sig = require('./signature.cjs')
const { keyOf, extOf, isMedia, VIDEO_EXT, skippedExtensions } = require('./library.cjs')

// "Watch for new duplicates" (ported from DupeLens' WatchService): new files that show up in the
// library folders are checked against what is already there, and an alert is raised when one is
// an exact copy (same size + same content hash) or, for photos, looks like a known photo
// (perceptual fingerprint within the duplicate-matching threshold).
//
// The index of known files is Lumen's own: the library items plus the duplicate finder's cached
// records (content hash `x`, fingerprint `s`, crops `c`, low detail `lo`). Paths come from the
// library's folder watcher (Library 'file' events) through queue().

const QUIET_MS = 3000 // wait until nothing has changed for this long (copies finishing)
const RETRY_MS = 3000 // still being written or locked: try again after
const GIVE_UP_MS = 2 * 60_000 // ...for at most this long
const BUSY_MS = 2000 // a check is still running: come back after
const LOG_SIZE = 20
const RECENT_SIZE = 200 // new files remembered so a second new copy matches the first
const VANISHED_MS = 10 * 60_000 // a known file that disappeared: a new file like it was moved here

// Same algorithm as duplicates.cjs contentHash() — it must stay identical so the cached `x`
// values of duplicate records compare with hashes made here. (Uses the exported one if present.)
const FULL_HASH_MAX = 32 * 1024 * 1024
const SAMPLE = 64 * 1024
const SAMPLES = 32
async function localContentHash(file, size) {
  const h = crypto.createHash('sha1')
  h.update(String(size))
  if (size <= FULL_HASH_MAX) {
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) h.update(chunk)
  } else {
    const fh = await fsp.open(file, 'r')
    try {
      const buf = Buffer.alloc(1024 * 1024)
      await fh.read(buf, 0, buf.length, 0)
      h.update(buf)
      await fh.read(buf, 0, buf.length, size - buf.length)
      h.update(buf)
      const chunk = Buffer.alloc(SAMPLE)
      for (let i = 1; i <= SAMPLES; i++) {
        await fh.read(chunk, 0, SAMPLE, Math.floor((size - SAMPLE) * (i / (SAMPLES + 1))))
        h.update(chunk)
      }
    } finally {
      await fh.close()
    }
  }
  return h.digest('base64').slice(0, 24)
}
let contentHash = localContentHash
try {
  const exported = require('./duplicates.cjs').contentHash
  if (typeof exported === 'function') contentHash = exported
} catch {}

let sharpModule = null
const sharp = () => (sharpModule ??= require('sharp'))

const extractChannel = (data, channels) => {
  const out = new Uint8Array(data.length / channels)
  for (let i = 0; i < out.length; i++) out[i] = data[i * channels]
  return out
}

/**
 * Fingerprint of a new photo, as duplicates.cjs visual() does it for previews: upright (EXIF
 * orientation applied), at most 384 px, flattened on white, grey. `src` = file path or image bytes.
 */
async function fingerprint(src) {
  const { data, info } = await sharp()(src, { failOn: 'none' })
    .rotate()
    .resize(sig.ANALYSIS_SIZE, sig.ANALYSIS_SIZE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const gray = info.channels === 1 ? data : extractChannel(data, info.channels)
  let tiny = null
  if (info.width < sig.GRID || info.height < sig.GRID) {
    const t = await sharp()(src, { failOn: 'none' })
      .rotate()
      .resize(sig.GRID, sig.GRID, { fit: 'fill' })
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    tiny = t.info.channels === 1 ? t.data : extractChannel(t.data, t.info.channels)
  }
  return sig.analyze(gray, info.width, info.height, tiny)
}

/** Another program still has the file open without sharing it (copy in progress). */
async function isLocked(file) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
    await fh.read(Buffer.alloc(1), 0, 1, 0)
    return false
  } catch (err) {
    return err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES'
  } finally {
    await fh?.close().catch(() => {})
  }
}

const exists = (p) => fsp.access(p).then(
  () => true,
  () => false,
)

const plural = (n, word) => (n === 1 ? `1 ${word}` : `${n.toLocaleString('en-US')} ${word}s`)
const hhmm = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const value = (v) => (typeof v === 'function' ? v() : v)
/** Same objects in the same order? (Items aren't renamed in place: a moved file is a new item.) */
const sameItems = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((it, i) => it === b[i])
const normFolder = (x) => keyOf(path.resolve(String(x))).replace(/[\\/]+$/, '')

/** DupeLens' alert texts. */
const alertText = (name, matchName, exact) =>
  exact ? `“${name}” is an exact copy of “${matchName}”.` : `“${name}” looks like “${matchName}”.`

/**
 * @typedef {{ file: string, name: string, match: string, matchName: string, matchId?: string,
 *   kind: 'exact' | 'similar', distance?: number, text: string, time: number, line: string }} WatchAlert
 *
 * Events: 'alert' (WatchAlert), 'status' ({ watching, folders, text }).
 */
class WatchAlerts extends EventEmitter {
  /**
   * @param {object} [options] each may also be a function returning the current value
   * @param {object[] | (() => object[])} [options.items] library items ({ id, path, name, type, size, mtime })
   * @param {Map<string, object> | object | (() => any)} [options.records] duplicate records by item id
   * @param {number} [options.sensitivity] match threshold in % (80–99), as the duplicate finder
   * @param {boolean} [options.findCrops] also match centre crops (as the duplicate finder)
   * @param {string[]} [options.exclude] folders whose new files are ignored (removed duplicates, skipped folders…)
   * @param {string[]} [options.skipTypes] library FILE_TYPES keys that are not scanned
   * @param {number} [options.minBytes] files under this size are not scanned
   * @param {(file: string, ext: string) => Promise<Buffer | string | null>} [options.decode] a
   *   picture of a new photo that sharp can read (e.g. a rendered preview for HEIC/RAW); null →
   *   the file itself is decoded with sharp
   */
  constructor(options = {}) {
    super()
    this.options = {
      items: [],
      records: new Map(),
      sensitivity: 90,
      findCrops: true,
      exclude: [],
      skipTypes: [],
      minBytes: 0,
      decode: null,
      quietMs: QUIET_MS,
      retryMs: RETRY_MS,
      giveUpMs: GIVE_UP_MS,
      busyMs: BUSY_MS,
      now: Date.now,
      ...options,
    }
    this.running = false
    this.watchFolders = []
    this.pending = new Map() // key -> { file, queued }
    this.ignored = new Map() // key -> until (ms)
    this.recent = new Map() // key -> { path, name, size, mtime, type, x?, w?, c, lo }
    this.hashes = new Map() // key -> { m, z, x } of known files hashed here
    this.words = new Map() // item id -> { s, w } parsed fingerprints
    this.vanished = new Map() // key -> { size, mtime, at } of known files that just disappeared
    this.index = null // { ref: items array, map: key -> item }
    this.alerts = [] // newest first, at most 20
    this.timer = null
    this.processing = false
    this.disposed = false
  }

  /** Changes options (e.g. sensitivity, exclude, skip lists). */
  configure(patch) {
    Object.assign(this.options, patch)
  }

  get watching() {
    return this.running
  }

  get folders() {
    return [...this.watchFolders]
  }

  /** DupeLens' status line, e.g. "Watching 2 folders for new duplicates" ('' when off). */
  get statusText() {
    return this.running ? `Watching ${plural(this.watchFolders.length, 'folder')} for new duplicates` : ''
  }

  /** The last 20 alerts, newest first. `line` = "HH:mm  text" as DupeLens' watch log. */
  get log() {
    return this.alerts.slice()
  }

  status() {
    return { watching: this.running, folders: this.folders, text: this.statusText }
  }

  /**
   * Starts watching (the library's watcher supplies the paths). Returns false when none of
   * `folders` exists — nothing to watch, as in DupeLens.
   */
  start(folders) {
    if (this.disposed) return false
    this.clearPending()
    this.watchFolders = (Array.isArray(folders) ? folders : []).filter((f) => {
      try {
        return typeof f === 'string' && fs.statSync(f).isDirectory()
      } catch {
        return false
      }
    })
    this.running = this.watchFolders.length > 0
    this.emit('status', this.status())
    return this.running
  }

  stop() {
    const was = this.running
    this.running = false
    this.watchFolders = []
    this.clearPending()
    if (was) this.emit('status', this.status())
  }

  dispose() {
    this.stop()
    this.disposed = true
    this.removeAllListeners()
  }

  clearPending() {
    clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  /** Don't alert about these files for a while (e.g. ones Lumen itself just wrote or restored). */
  ignore(files, ms = 60_000) {
    const until = this.options.now() + ms
    for (const f of Array.isArray(files) ? files : [files]) if (typeof f === 'string') this.ignored.set(keyOf(path.resolve(f)), until)
  }

  isIgnored(key) {
    const until = this.ignored.get(key)
    if (until === undefined) return false
    if (this.options.now() < until) return true
    this.ignored.delete(key)
    return false
  }

  /** A test for "under an excluded folder, or in any folder named Duplicates" (DupeLens' rule). */
  excludedTest() {
    const folders = (value(this.options.exclude) ?? []).filter((x) => typeof x === 'string' && x).map(normFolder)
    const marker = `${path.sep}duplicates${path.sep}`
    return (file) => {
      const p = keyOf(file)
      if (p.toLowerCase().includes(marker)) return true
      return folders.some((f) => p === f || p.startsWith(f + path.sep))
    }
  }

  isExcluded(file) {
    return this.excludedTest()(file)
  }

  /**
   * A file event from the folder watcher. 'rename' (created / renamed / deleted) queues the file;
   * 'change' only counts as activity for files already waiting (a copy still being written).
   */
  queue(file, event = 'rename') {
    if (!this.running || typeof file !== 'string' || !file) return
    const full = path.resolve(file)
    const key = keyOf(full)
    if (event === 'change' && !this.pending.has(key)) return
    if (!isMedia(full)) return
    if (event !== 'change' && !fs.existsSync(full)) {
      // deleted, or the old name of a renamed / moved file: nothing to check, but remember it
      this.noteVanished(key)
      return
    }
    if (skippedExtensions(value(this.options.skipTypes)).has(extOf(full))) return
    if (this.isExcluded(full) || this.isIgnored(key)) return
    const now = this.options.now()
    this.pending.set(key, { file: full, queued: this.pending.get(key)?.queued ?? now })
    this.schedule(this.options.quietMs) // every event restarts the quiet period
  }

  /** Known files by path key (rebuilt when the library list is replaced). */
  knownByKey() {
    const items = this.items()
    const index = this.index
    // The same items in a new array (private.cjs' split() makes one on every call): comparing them
    // costs far less than building a 15,000-entry map again.
    if (index && index.ref !== items && sameItems(index.ref, items)) index.ref = items
    if (this.index?.ref !== items) this.index = { ref: items, map: new Map(items.filter((it) => it?.path).map((it) => [keyOf(it.path), it])) }
    return this.index.map
  }

  noteVanished(key) {
    const it = this.knownByKey().get(key) ?? this.recent.get(key)
    if (!it || !it.size) return
    const now = this.options.now()
    this.vanished.set(key, { size: it.size, mtime: it.mtime, at: now })
    for (const [k, v] of this.vanished) if (now - v.at > VANISHED_MS || this.vanished.size > 1000) this.vanished.delete(k)
  }

  /** Same size and modified time as a known file that just disappeared: moved or renamed, not new. */
  wasMoved(self) {
    const now = this.options.now()
    for (const [k, v] of this.vanished) {
      if (now - v.at > VANISHED_MS) this.vanished.delete(k)
      else if (v.size === self.size && v.mtime === self.mtime) {
        this.vanished.delete(k)
        return true
      }
    }
    return false
  }

  schedule(ms) {
    if (!this.running) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.process().catch((err) => console.error('[watch-alerts] check failed', err))
    }, ms)
  }

  /** Checks every waiting file now (normally run by the timer). */
  async process() {
    if (!this.running) return
    if (this.processing) {
      this.schedule(this.options.busyMs)
      return
    }
    this.processing = true
    try {
      for (const [key, entry] of [...this.pending]) {
        if (!this.running) break
        if (this.pending.get(key) !== entry) continue
        this.pending.delete(key)
        let ready = true
        try {
          ready = (await this.check(entry.file)) !== false
        } catch {
          ready = true // unreadable: ignore
        }
        if (!ready && this.running && this.options.now() - entry.queued < this.options.giveUpMs) {
          // still being copied: try again shortly (unless a newer event re-queued it already)
          if (!this.pending.has(key)) this.pending.set(key, entry)
          this.schedule(this.options.retryMs)
        }
      }
    } finally {
      this.processing = false
    }
  }

  items() {
    return value(this.options.items) ?? []
  }

  record(id) {
    const records = value(this.options.records)
    if (!records) return undefined
    return typeof records.get === 'function' ? records.get(id) : records[id]
  }

  /** Content hash of a known file: the duplicate finder's cached one, else computed (and kept). */
  async knownHash(known) {
    const r = known.id ? this.record(known.id) : null
    if (r?.x && r.m === known.mtime && r.z === known.size) return r.x
    if (known.x) return known.x
    const key = keyOf(known.path)
    const cached = this.hashes.get(key)
    if (cached && cached.m === known.mtime && cached.z === known.size) return cached.x
    let st
    try {
      st = await fsp.stat(known.path)
    } catch {
      return null
    }
    if (st.size !== known.size) return null
    const x = await contentHash(known.path, known.size).catch(() => null)
    if (!x) return null
    if (this.hashes.size > 5000) this.hashes.clear()
    this.hashes.set(key, { m: known.mtime, z: known.size, x })
    return x
  }

  wordsOf(id, s) {
    const hit = this.words.get(id)
    if (hit && hit.s === s) return hit.w
    const w = sig.fromBase64(s)
    this.words.set(id, { s, w })
    return w
  }

  async fingerprintOf(file, ext) {
    let src = null
    if (typeof this.options.decode === 'function') {
      try {
        src = await this.options.decode(file, ext)
      } catch {}
    }
    try {
      return await fingerprint(src || file)
    } catch {
      return null // a format sharp can't read and no rendered picture: exact copies only
    }
  }

  remember(entry) {
    const key = keyOf(entry.path)
    this.recent.delete(key)
    this.recent.set(key, entry)
    while (this.recent.size > RECENT_SIZE) this.recent.delete(this.recent.keys().next().value)
  }

  /**
   * Checks one new file. Resolves to the alert, null (no duplicate / nothing to check) or false
   * (still being written or locked: check again later).
   * @returns {Promise<WatchAlert | null | false>}
   */
  async check(file) {
    file = path.resolve(file)
    if (this.isIgnored(keyOf(file))) return null // (ignore() may come after the watcher queued it)
    let st
    try {
      st = await fsp.stat(file)
    } catch {
      return null // gone again
    }
    if (!st.isFile()) return null
    if (st.size === 0 || (await isLocked(file))) return false
    if (st.size < (Number(value(this.options.minBytes)) || 0)) return null
    const key = keyOf(file)
    const ext = extOf(file)
    const type = VIDEO_EXT.has(ext) ? 'video' : 'image'
    const mtime = Math.round(st.mtimeMs)
    const items = this.items()
    // known files other than this one (and not ones in excluded folders, e.g. moved-away duplicates)
    const excluded = this.excludedTest()
    const others = (list) => list.filter((k) => k && typeof k.path === 'string' && keyOf(k.path) !== key && !excluded(k.path))
    const recent = others([...this.recent.values()])
    const self = { path: file, name: path.basename(file), size: st.size, mtime, added: Math.round(st.birthtimeMs) || mtime, type, c: 0, lo: 0 }
    // the file that was there first is named (the original rather than an earlier copy)
    const arrival = (k) => (Number.isFinite(k.added) ? k.added : Infinity)

    // a known file moved or renamed within the library is not a new duplicate
    if (this.wasMoved(self)) {
      this.remember(self)
      return null
    }

    let match = null
    let exact = false
    let distance

    // 1. exact copy: only files of the same size can be identical
    const sameSize = others(items.filter((k) => k && k.size === st.size))
      .concat(recent.filter((k) => k.size === st.size))
      .sort((a, b) => arrival(a) - arrival(b))
    for (const known of sameSize) {
      const x = await this.knownHash(known)
      if (!x) continue
      self.x ??= await contentHash(file, st.size)
      if (x === self.x && (await exists(known.path))) {
        match = known
        exact = true
        break
      }
    }

    // 2. look-alike photo (not blank ones: those would match everything)
    if (type === 'image') {
      const v = await this.fingerprintOf(file, ext)
      if (v) Object.assign(self, { w: v.words, c: v.crops ? 1 : 0, lo: v.lowDetail ? 1 : 0 })
      if (!match && v && !v.lowDetail) {
        const maxDist = sig.maxDistanceFor((Number(value(this.options.sensitivity)) || 90) / 100)
        const crops = value(this.options.findCrops) !== false
        const found = []
        for (const known of others(items)) {
          if (known.type !== 'image') continue
          const r = this.record(known.id)
          if (!r?.s || r.lo || r.m !== known.mtime || r.z !== known.size) continue
          const d = sig.compare(this.wordsOf(known.id, r.s), crops && !!r.c, v.words, crops && v.crops).distance
          if (d <= maxDist) found.push({ known, d })
        }
        for (const known of recent) {
          if (known.type !== 'image' || !known.w || known.lo) continue
          const d = sig.compare(known.w, crops && !!known.c, v.words, crops && v.crops).distance
          if (d <= maxDist) found.push({ known, d })
        }
        found.sort((a, b) => a.d - b.d || arrival(a.known) - arrival(b.known))
        for (const f of found) {
          if (await exists(f.known.path)) {
            match = f.known
            distance = f.d
            break
          }
        }
      }
    }

    // remember it, so a second new copy of the same picture is caught too
    this.remember(self)
    if (this.words.size > items.length * 2 + 1000) this.words.clear()
    if (!match || this.disposed) return null

    const name = path.basename(file)
    const matchName = match.name || path.basename(match.path)
    const text = alertText(name, matchName, exact)
    const time = this.options.now()
    /** @type {WatchAlert} */
    const alert = {
      file,
      name,
      match: match.path,
      matchName,
      ...(match.id ? { matchId: match.id } : {}),
      kind: exact ? 'exact' : 'similar',
      ...(exact ? {} : { distance }),
      text,
      time,
      line: `${hhmm(time)}  ${text}`,
    }
    this.alerts.unshift(alert)
    if (this.alerts.length > LOG_SIZE) this.alerts.length = LOG_SIZE
    this.emit('alert', alert)
    return alert
  }
}

const TEXTS = {
  notificationTitle: 'New duplicate found',
  /** In-app toast (DupeLens): `New duplicate: ${text} Rescan to review it.` */
  toast: (text) => `New duplicate: ${text} Rescan to review it.`,
}

module.exports = { WatchAlerts, alertText, fingerprint, TEXTS }
