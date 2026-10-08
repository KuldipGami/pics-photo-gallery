const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const sharp = require('sharp')
const { writeAtomic, writeAtomicSync, serial, readJson } = require('./safe-file.cjs')

const VERSION = 1 // bump to read every picture again (engine or reading settings changed)
// Long side the engine reads. Body text of a page photographed from arm's length is still legible
// at 2560 (98 % of words in tests, 94 % at 2048); larger only costs time.
const MAX_SIDE = 2560
// Smaller pictures are read at twice their size: 9–11 px text goes from ~50 % to ~95 % of words.
const SMALL_SIDE = 1280
const CORES = os.availableParallelism?.() ?? os.cpus().length
// Engine processes reading at once. Each uses ~3 threads and ~250 MB; two roughly double the speed.
const ENGINES = CORES >= 12 ? 2 : 1
const RECYCLE_AFTER = 250 // pictures per engine process before a fresh one (keeps its memory flat)
const IDLE_CLOSE_MS = 20_000
const START_TIMEOUT_MS = 45_000 // the first start after an install can be slow (virus scan)
const READ_TIMEOUT_MS = 60_000
const MAX_TEXT = 20_000 // characters kept per picture
const MAX_RESULTS = 3000
const ALPHA_EXT = new Set(['png', 'webp', 'gif', 'tif', 'tiff', 'avif'])
const NO_LANGUAGE = 'Windows has no text recognition language installed (Settings › Time & language › Language)'

// Pictures likely to contain text are read first: screenshots, scans, saved and forwarded images.
const TEXT_NAME = /screen ?shot|screen_?cap|capture|snip|scan|receipt|invoice|bill|document|ticket|boarding|whatsapp|-wa\d|telegram|signal-|note|menu|slide|whiteboard/i
const TEXT_DIR = /screen ?shots?|scans?|documents?|docs|receipts?|whatsapp|telegram|downloads?|notes|slides/i

function priority(item) {
  let p = 0
  if (TEXT_NAME.test(item.name) || TEXT_DIR.test(path.basename(item.dir))) p += 2
  if (['png', 'gif', 'webp', 'bmp'].includes(item.ext)) p += 1
  if (!item.meta?.make) p += 1 // not from a camera
  return p
}

/** Lower case without accents, like the search box ("cafe" finds "Café"). */
const fold = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
const WORD = /[\p{L}\p{N}]+/gu

/** Search words: at least two letters or digits each. */
const queryWords = (query) => [...new Set(fold(String(query)).match(WORD) ?? [])].filter((w) => w.length > 1).slice(0, 8)

/** The words of a line; numbers split by spaces or dashes are also kept whole ("98765 43210"). */
function wordsOf(foldedLine) {
  const words = foldedLine.match(WORD) ?? []
  for (const run of foldedLine.match(/\d+(?:[ .\-/]\d+)+/g) ?? []) words.push(run.replace(/\D/g, ''))
  return words
}

/** Recognised lines → stored text: one line per line, without specks read as letters. */
function clean(lines) {
  const out = []
  let total = 0
  for (const line of lines ?? []) {
    const t = String(line.t ?? '').replace(/\s+/g, ' ').trim()
    if (!/[\p{L}\p{N}]{2}/u.test(t)) continue
    out.push(t)
    total += t.length + 1
    if (total > MAX_TEXT) break
  }
  return out.join('\n')
}

/**
 * A picture as JPEG bytes for the engine: upright, transparency on white (black text on a
 * transparent background would otherwise read as black on black), scaled like the engine does.
 */
async function prepare(input) {
  const meta = await sharp(input, { failOn: 'none' }).metadata()
  const long = Math.max(meta.autoOrient?.width ?? meta.width ?? 0, meta.autoOrient?.height ?? meta.height ?? 0)
  if (!long) throw new Error('Unreadable picture')
  const side = Math.round(long < SMALL_SIDE ? Math.min(long * 2, MAX_SIDE) : Math.min(long, MAX_SIDE))
  return sharp(input, { failOn: 'none' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(side, side, { fit: 'inside', kernel: 'lanczos3' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer()
}

/** Windows PowerShell can't open paths of 260+ characters without the \\?\ prefix. */
function longPath(file) {
  if (file.length < 240 || file.startsWith('\\\\?\\')) return file
  const full = path.resolve(file)
  return full.startsWith('\\\\') ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`
}

function powershell() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(exe) ? exe : 'powershell.exe'
}

/**
 * One PowerShell process running ocr-engine.ps1 (Windows.Media.Ocr), reading one picture at a time.
 * Started on first use, so PowerShell and WinRT load once (~0.5 s), not per picture.
 */
class OcrEngine {
  constructor(script) {
    this.script = script
    this.child = null
    this.ready = null
    this.pending = null
    this.seq = 0
    this.served = 0
    this.info = null
  }

  /** Resolves to { lang, max } once the engine answers; rejects if it can't start. */
  start() {
    if (this.closed) return Promise.reject(new Error('The app is closing'))
    if (this.ready) return this.ready
    const child = spawn(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.served = 0
    // Reading text uses several cores for an hour on a first run: it gives way to everything else.
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {}
    let stderr = ''
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
    child.stdin.on('error', () => {}) // it went away mid-write: 'exit' handles it
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Text recognition did not start'))
        this.kill(child)
      }, START_TIMEOUT_MS)
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
        if (this.child === child) {
          this.child = null
          this.ready = null
        }
      })
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if ('ready' in msg) {
          clearTimeout(timer)
          if (!msg.ready) return reject(new Error(msg.error === 'no-language' ? NO_LANGUAGE : `Text recognition did not start: ${msg.error}`))
          this.info = msg
          resolve(msg)
        } else if (this.pending && msg.seq === this.pending.seq) {
          const job = this.pending
          this.pending = null
          clearTimeout(job.timer)
          job.resolve(msg)
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        const detail = stderr.replace(/#< CLIXML[\s\S]*?(<\/Objs>|$)/g, '').trim().split(/\r?\n/)[0]
        reject(new Error(`Text recognition stopped${detail ? `: ${detail}` : ` (${code})`}`))
        if (this.child === child) {
          this.child = null
          this.ready = null
        }
        if (this.pending?.child === child) {
          const job = this.pending
          this.pending = null
          clearTimeout(job.timer)
          job.resolve(null)
        }
      })
    })
    ready.catch(() => {})
    this.ready = ready
    // Background work: let everything else on the PC go first.
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {}
    return ready
  }

  /**
   * Reads one picture. `request`: ['f', path, max, small] or ['b', base64, max, small].
   * Resolves to the engine's answer, { ok: false, timeout: true }, or null if the engine went away.
   */
  async run(request) {
    await this.start()
    const child = this.child
    if (!child || this.pending || child.exitCode !== null) return null
    return new Promise((resolve) => {
      const seq = ++this.seq
      const timer = setTimeout(() => {
        if (this.pending?.seq !== seq) return
        this.pending = null
        resolve({ ok: false, timeout: true })
        this.kill(child) // stuck on this picture
      }, READ_TIMEOUT_MS)
      this.pending = { seq, child, resolve, timer }
      this.served++
      child.stdin.write(`${seq}\t${request.join('\t')}\n`)
    })
  }

  /** Lets the process finish and exit (a fresh one starts on the next run). */
  close() {
    const child = this.child
    if (!child) return
    this.child = null
    this.ready = null
    try {
      child.stdin.end()
    } catch {}
    setTimeout(() => this.kill(child), 5000).unref()
  }

  kill(child = this.child) {
    if (!child) return
    if (this.child === child) {
      this.child = null
      this.ready = null
    }
    try {
      child.kill()
    } catch {}
  }

  dispose() {
    this.closed = true
    this.kill()
  }
}

/**
 * "Search the text in photos": Windows' built-in OCR reads every photo (screenshots and other
 * likely-text pictures first) in the background, keeping the text in ocr.json. Searching is
 * a word match over that text, all in this process.
 */
class OcrIndex extends EventEmitter {
  /**
   * @param {string} file  the cache (ocr.json); ocr-engine.ps1 is copied next to it
   * @param {object} options
   *  - canRun(): whether background work may run now
   *  - image(item): what to read instead of the file itself: a path or JPEG/PNG bytes (optional)
   *  - render(item): Promise<path | Buffer | null> for a file Windows can't open (optional)
   */
  constructor(file, { canRun, image, render } = {}) {
    super()
    this.file = file
    this.script = path.join(path.dirname(file), 'ocr-engine.ps1')
    this.canRun = canRun ?? (() => true)
    this.image = image
    this.render = render
    this.records = new Map() // id -> { m: mtime, s: size, t: text ('' = no text) }
    this.media = new Map() // id -> library item
    this.enabled = true
    this.halted = false
    this.error = null
    this.lang = null
    this.queue = []
    this.inflight = new Set()
    this.failed = new Set() // unreadable this session
    this.attempts = new Map() // id -> times the engine went away while reading it
    this.slots = []
    this.startFailures = 0
    this.progress = { done: 0, total: 0 }
    this.prepared = new WeakMap() // record -> { lines, folded, words }
    this.timers = {}
    this.dirty = false // changes not on disk yet
    this.blocked = false // ocr.json couldn't be read: don't save over it this session
    this.writer = serial(async () => {
      const text = this.serialize()
      this.writing = true
      try {
        await writeAtomic(this.file, text)
      } finally {
        this.writing = false
        if (this.flushed) {
          // saveNow() wrote newer text while this one was on its way: put that back on top
          this.flushed = false
          try {
            writeAtomicSync(this.file, this.serialize())
          } catch {}
        }
      }
    })
  }

  get available() {
    return process.platform === 'win32'
  }

  // ---------- persistence: { v, lang, items: { id: [mtime, size, text?] } } ----------

  async load() {
    const r = await readJson(this.file)
    if (r.error) {
      this.blocked = true
      console.error('[ocr] ocr.json could not be read; not saving over it this session', r.error)
      return
    }
    if (r.corrupt) console.error(`[ocr] ocr.json was damaged (kept as ${r.keptAs}); reading the text again`)
    const data = r.data
    if (data?.v !== VERSION || !data.items || typeof data.items !== 'object') return
    this.lang = data.lang ?? null
    for (const [id, r] of Object.entries(data.items)) {
      if (Array.isArray(r) && Number.isFinite(r[0])) this.records.set(id, { m: r[0], s: r[1], t: typeof r[2] === 'string' ? r[2] : '' })
    }
  }

  serialize() {
    const items = {}
    for (const [id, r] of this.records) items[id] = r.t ? [r.m, r.s, r.t] : [r.m, r.s]
    return JSON.stringify({ v: VERSION, lang: this.lang, items })
  }

  saveSoon(ms = 30_000) {
    this.dirty = true
    if (this.timers.save) return
    this.timers.save = setTimeout(() => this.save(), ms)
  }

  async save() {
    clearTimeout(this.timers.save)
    this.timers.save = null
    if (this.blocked) return
    this.dirty = false
    try {
      await this.writer()
    } catch (err) {
      console.error('Failed to save text index', err)
      this.saveSoon(60_000) // still owed: again later, and at quit
    }
  }

  saveNow() {
    if (this.blocked || (!this.dirty && !this.writing)) return
    clearTimeout(this.timers.save)
    this.timers.save = null
    try {
      writeAtomicSync(this.file, this.serialize())
      this.dirty = false
    } catch (err) {
      console.error('Failed to save text index', err)
    }
    if (this.writing) this.flushed = true
  }

  // ---------- pipeline ----------

  sync(items) {
    this.media = new Map(items.map((it) => [it.id, it]))
    let dropped = false
    for (const [id, r] of this.records) {
      const it = this.media.get(id)
      if (!it || it.mtime !== r.m || it.size !== r.s) {
        this.records.delete(id)
        dropped = true
      }
    }
    if (dropped) {
      this.saveSoon()
      this.changedSoon()
    }
    this.queue = [...this.media.values()]
      .filter((it) => it.type === 'image' && !this.records.has(it.id) && !this.inflight.has(it.id) && !this.failed.has(it.id))
      .map((it) => [it, priority(it)])
      .sort((a, b) => b[1] - a[1] || b[0].date - a[0].date)
      .map(([it]) => it.id)
    this.progress = { done: 0, total: this.queue.length }
    this.emitProgress()
    this.pump()
  }

  pump() {
    if (!this.enabled || this.halted || this.disposed || !this.available || this.timers.retry || !this.canRun()) return this.closeSoon()
    while (this.slots.length < ENGINES) this.slots.push({ engine: new OcrEngine(this.script), busy: false })
    const reading = [] // put back while still being read: their turn comes once that's over
    for (const slot of this.slots) {
      if (slot.busy) continue
      if (slot !== this.slots[0] && !this.slots[0].engine.info) break // more engines once one has started
      let item = null
      while (!item && this.queue.length) {
        const it = this.media.get(this.queue.shift())
        if (!it || this.records.has(it.id)) continue
        if (this.inflight.has(it.id)) reading.push(it.id)
        else item = it
      }
      if (!item) break
      clearTimeout(this.timers.idle)
      this.timers.idle = null
      slot.busy = true
      this.inflight.add(item.id)
      this.read(slot.engine, item)
        .catch((err) => console.error('[ocr]', err))
        .finally(() => {
          slot.busy = false
          this.inflight.delete(item.id)
          this.emitProgress()
          this.pump()
        })
    }
    this.queue.push(...reading)
    this.closeSoon()
  }

  /** Engine processes hold ~250 MB each: close them once there's nothing to read for a while. */
  closeSoon() {
    if (this.inflight.size || this.timers.idle) return
    this.timers.idle = setTimeout(() => {
      this.timers.idle = null
      if (!this.inflight.size) for (const slot of this.slots) slot.engine.close()
    }, IDLE_CLOSE_MS)
    this.timers.idle.unref?.()
  }

  async ensureScript() {
    this.scriptReady ??= (async () => {
      const source = fs.readFileSync(path.join(__dirname, 'ocr-engine.ps1'), 'utf8') // inside app.asar when packaged
      const current = await fsp.readFile(this.script, 'utf8').catch(() => null)
      if (current !== source) await writeAtomic(this.script, source)
    })()
    return this.scriptReady.catch((err) => {
      this.scriptReady = null
      throw err
    })
  }

  /**
   * The engine request for a path or picture bytes. `decodeHere`: decode a path with sharp rather
   * than Windows (a second try for a file Windows couldn't open).
   */
  async request(src, decodeHere = false) {
    if (Buffer.isBuffer(src)) {
      const data = await prepare(src).catch(() => src) // not something sharp reads: let Windows try
      return ['b', data.toString('base64'), MAX_SIDE, data === src ? SMALL_SIDE : 0]
    }
    if (typeof src !== 'string' || !src) return null
    if (decodeHere) return ['b', (await prepare(src)).toString('base64'), MAX_SIDE, 0]
    const ext = path.extname(src).slice(1).toLowerCase()
    if (/[\t\r\n]/.test(src) || ALPHA_EXT.has(ext)) {
      const meta = /[\t\r\n]/.test(src) ? { hasAlpha: true } : await sharp(src, { failOn: 'none' }).metadata().catch(() => null)
      if (meta?.hasAlpha) return ['b', (await prepare(src)).toString('base64'), MAX_SIDE, 0]
    }
    return ['f', longPath(src), MAX_SIDE, SMALL_SIDE]
  }

  async read(engine, item) {
    const retry = () => {
      const n = (this.attempts.get(item.id) ?? 0) + 1
      this.attempts.set(item.id, n)
      if (n < 2) this.queue.push(item.id)
      else {
        this.failed.add(item.id)
        this.progress.done++
      }
    }
    try {
      await this.ensureScript()
      const info = await engine.start()
      this.startFailures = 0
      if (info.lang && this.lang !== info.lang) {
        this.lang = info.lang
        this.saveSoon()
      }
    } catch (err) {
      if (this.disposed || !this.enabled) return
      this.queue.unshift(item.id)
      const message = String(err?.message || err)
      console.error(`[ocr] ${message}`)
      // Try again in a minute (a slow first start shouldn't switch it off), then give up for the session.
      if (++this.startFailures >= 2 || message.startsWith(NO_LANGUAGE)) {
        this.halted = true
        this.error = message
        for (const slot of this.slots) slot.engine.kill()
      } else if (!this.timers.retry) {
        this.timers.retry = setTimeout(() => {
          this.timers.retry = null
          this.pump()
        }, 60_000)
      }
      return
    }
    let res = null
    try {
      const src = (this.image ? await this.image(item) : null) ?? item.path
      const request = await this.request(src).catch(() => null)
      res = request ? await engine.run(request) : { ok: false, stage: 'decode' }
      if (res && !res.ok && res.stage === 'decode' && this.render && !this.disposed) {
        // Windows couldn't open it: try the app's own decoders (a damaged JPEG, a format without a Windows codec).
        const other = await this.render(item).catch(() => null)
        const request2 = other ? await this.request(other, true).catch(() => null) : null
        if (request2) res = await engine.run(request2)
      }
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) }
    }
    if (this.disposed || !this.enabled) return
    if (!res || res.timeout) return retry() // the engine went away or got stuck on it
    this.progress.done++
    if (!res.ok) {
      this.failed.add(item.id)
      return
    }
    const now = this.media.get(item.id)
    if (!now) return // left the library meanwhile
    if (now.mtime !== item.mtime || now.size !== item.size) return void this.queue.push(item.id) // changed meanwhile
    const t = clean(res.lines)
    this.records.set(item.id, { m: item.mtime, s: item.size, t })
    if (engine.served >= RECYCLE_AFTER) engine.close()
    this.saveSoon()
    if (t) this.changedSoon()
  }

  // ---------- search ----------

  prepare(r) {
    let p = this.prepared.get(r)
    if (!p) {
      const lines = r.t.split('\n')
      const foldedLines = lines.map(fold)
      p = { lines, folded: foldedLines.join('\n'), words: foldedLines.map(wordsOf) }
      this.prepared.set(r, p)
    }
    return p
  }

  /** Records with text, of items still in the library. */
  *texts() {
    if (!this.enabled) return
    for (const [id, r] of this.records) if (r.t && this.media.has(id)) yield [id, r]
  }

  /**
   * Pictures whose text has every word of the query (a word matches the start of a word in the
   * text: "recei" finds "Receipt"), best first: { ids, snippets (the best matching line), scores }.
   */
  search(query) {
    const tokens = queryWords(query)
    const empty = { ids: [], snippets: [], scores: [] }
    if (!tokens.length) return empty
    const phrase = tokens.join(' ')
    const hits = []
    for (const [id, r] of this.texts()) {
      const p = this.prepare(r)
      if (!tokens.every((t) => p.folded.includes(t))) continue
      const found = new Set()
      let score = 0
      let best = -1
      let bestCount = 0
      p.words.forEach((words, line) => {
        const inLine = new Set()
        for (const w of words) {
          for (const t of tokens) {
            if (w === t) score += 3
            else if (w.startsWith(t)) score += 1
            else continue
            inLine.add(t)
          }
        }
        for (const t of inLine) found.add(t)
        if (inLine.size > bestCount) {
          bestCount = inLine.size
          best = line
        }
      })
      if (found.size < tokens.length) continue
      if (tokens.length > 1 && p.folded.includes(phrase)) score += 5 * tokens.length
      hits.push([id, score, snippet(p.lines[best], fold(p.lines[best]), tokens)])
    }
    hits.sort((a, b) => b[1] - a[1])
    const kept = hits.slice(0, MAX_RESULTS)
    return { ids: kept.map((h) => h[0]), snippets: kept.map((h) => h[2]), scores: kept.map((h) => h[1]) }
  }

  /**
   * For the main search box: for each (folded) search word, the pictures whose text has a word
   * starting with it — so "invoice march" can match "invoice" in the text and "march" in the date.
   */
  tokenHits(tokens) {
    const words = (Array.isArray(tokens) ? tokens : []).slice(0, 8).map((t) => fold(String(t)))
    const hits = words.map(() => [])
    if (!words.length) return hits
    for (const [id, r] of this.texts()) {
      const p = this.prepare(r)
      words.forEach((t, k) => {
        if (t.length < 2 || !p.folded.includes(t)) return
        if (p.words.some((ws) => ws.some((w) => w.startsWith(t)))) hits[k].push(id)
      })
    }
    return hits
  }

  /** The text read in a picture (lines separated by \n), or null if none was found or it isn't read yet. */
  text(id) {
    return (this.enabled && this.records.get(id)?.t) || null
  }

  // ---------- state ----------

  setEnabled(enabled) {
    this.enabled = enabled
    if (enabled) {
      this.halted = false
      this.error = null
      this.startFailures = 0
      clearTimeout(this.timers.retry)
      this.timers.retry = null
      this.sync([...this.media.values()])
    } else {
      this.queue = []
      this.progress = { done: 0, total: 0 }
      for (const slot of this.slots) slot.engine.kill()
    }
    this.emitProgress()
    this.changedSoon(0)
  }

  changedSoon(ms = 2000) {
    if (this.timers.changed) return
    this.timers.changed = setTimeout(() => {
      this.timers.changed = null
      this.emit('changed')
    }, ms)
  }

  emitProgress() {
    if (this.timers.progress) return
    this.timers.progress = setTimeout(() => {
      this.timers.progress = null
      this.emit('progress', this.progressInfo())
    }, 300)
  }

  progressInfo() {
    let indexed = 0
    let withText = 0
    for (const [id, r] of this.records) {
      if (!this.media.has(id)) continue
      indexed++
      if (r.t) withText++
    }
    return {
      ...this.progress,
      running: this.enabled && !this.halted && this.available && (this.inflight.size > 0 || this.queue.length > 0),
      indexed,
      withText,
      available: this.available,
      error: this.error,
      lang: this.lang,
    }
  }

  dispose() {
    this.disposed = true
    this.queue = []
    for (const key of ['idle', 'changed', 'progress', 'retry']) clearTimeout(this.timers[key])
    for (const slot of this.slots) slot.engine.dispose()
    this.saveNow()
  }
}

/** Up to ~100 characters of the line around the first search word. */
function snippet(line, folded, tokens) {
  if (!line) return ''
  if (line.length <= 100) return line
  const at = Math.min(...tokens.map((t) => folded.indexOf(t)).filter((i) => i >= 0), line.length)
  const start = Math.max(0, Math.min(at - 30, line.length - 100))
  return `${start > 0 ? '…' : ''}${line.slice(start, start + 100).trim()}${start + 100 < line.length ? '…' : ''}`
}

module.exports = { OcrIndex, OcrEngine, queryWords, fold }
