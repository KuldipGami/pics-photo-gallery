const fsp = require('node:fs/promises')
const path = require('node:path')
const { BrowserWindow, ipcMain } = require('electron')

// Main-process side of the hidden media worker windows (see worker.cjs).

const HEIF = /\.(heic|heif|hif)$/i
const META_MAX = 4 * 1024 * 1024

/** Child boxes of `buf` between `start` and `end`: [{ type, start (of the body), end }]. */
function boxes(buf, start, end) {
  const out = []
  for (let pos = start; pos + 8 <= end; ) {
    let size = buf.readUInt32BE(pos)
    let header = 8
    if (size === 1 && pos + 16 <= end) {
      size = Number(buf.readBigUInt64BE(pos + 8))
      header = 16
    } else if (size === 0) size = end - pos
    if (size < header || pos + size > end) break
    out.push({ type: buf.toString('latin1', pos + 4, pos + 8), start: pos + header, end: pos + size })
    pos += size
  }
  return out
}

/**
 * The size of a HEIF/HEIC picture as shown ({ width, height }, after its `irot` turn), from the
 * `ispe` property of its primary item; null when it can't be read. Reads only the `meta` box.
 */
async function heifSize(file) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const { size: fileSize } = await fh.stat()
    const head = Buffer.alloc(16)
    let meta = null
    for (let pos = 0, n = 0; pos + 8 <= fileSize && n < 64; n++) {
      await fh.read(head, 0, 16, pos)
      let size = head.readUInt32BE(0)
      let header = 8
      if (size === 1) {
        size = Number(head.readBigUInt64BE(8))
        header = 16
      } else if (size === 0) size = fileSize - pos
      if (size < header) return null
      if (head.toString('latin1', 4, 8) === 'meta') {
        if (size > META_MAX) return null
        meta = Buffer.alloc(size - header)
        await fh.read(meta, 0, meta.length, pos + header)
        break
      }
      pos += size
    }
    if (!meta || meta.length < 4) return null
    const kids = boxes(meta, 4, meta.length) // meta is a full box: skip version + flags
    const pitm = kids.find((b) => b.type === 'pitm')
    const iprp = kids.find((b) => b.type === 'iprp')
    if (!pitm || !iprp) return null
    const primary = meta[pitm.start] === 0 ? meta.readUInt16BE(pitm.start + 4) : meta.readUInt32BE(pitm.start + 4)
    const parts = boxes(meta, iprp.start, iprp.end)
    const ipco = parts.find((b) => b.type === 'ipco')
    const ipma = parts.find((b) => b.type === 'ipma')
    if (!ipco || !ipma) return null
    const props = boxes(meta, ipco.start, ipco.end) // 1-based in ipma
    const version = meta[ipma.start]
    const wide = meta[ipma.start + 3] & 1
    let p = ipma.start + 4
    const count = meta.readUInt32BE(p)
    p += 4
    for (let i = 0; i < count && p < ipma.end; i++) {
      const id = version < 1 ? meta.readUInt16BE(p) : meta.readUInt32BE(p)
      p += version < 1 ? 2 : 4
      const n = meta[p++]
      const linked = []
      for (let k = 0; k < n; k++) {
        linked.push(wide ? meta.readUInt16BE(p) & 0x7fff : meta[p] & 0x7f)
        p += wide ? 2 : 1
      }
      if (id !== primary) continue
      let width = 0
      let height = 0
      let turned = false
      for (const index of linked) {
        const box = props[index - 1]
        if (box?.type === 'ispe' && box.start + 12 <= box.end) {
          width = meta.readUInt32BE(box.start + 4)
          height = meta.readUInt32BE(box.start + 8)
        } else if (box?.type === 'irot' && box.start < box.end) turned = (meta[box.start] & 3) % 2 === 1
      }
      if (!width || !height) return null
      return turned ? { width: height, height: width } : { width, height }
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

let seq = 0
const pending = new Map() // seq -> { resolve, timer, worker, win, contents, since, expire, timeoutMs, onProgress }
const byContents = new WeakMap() // a worker window's webContents -> its MediaWorker

/** Any answer from a worker window shows its page isn't stuck. */
const heardFrom = (sender) => {
  const worker = byContents.get(sender)
  if (worker) worker.lastReply = Date.now()
}

ipcMain.on('worker:done', (event, msg) => {
  heardFrom(event.sender)
  const job = pending.get(msg?.seq)
  if (!job || job.contents !== event.sender) return
  pending.delete(msg.seq)
  clearTimeout(job.timer)
  job.resolve(msg)
})

// Long jobs (video fingerprints) report progress; each report restarts their timeout, so the
// timeout means "no progress for this long" rather than a limit on the whole job.
ipcMain.on('worker:progress', (event, msg) => {
  heardFrom(event.sender)
  const job = pending.get(msg?.seq)
  if (!job || job.contents !== event.sender) return
  clearTimeout(job.timer)
  job.since = Date.now()
  job.timer = setTimeout(job.expire, job.timeoutMs)
  try {
    job.onProgress?.(msg.fraction)
  } catch {}
})

class MediaWorker {
  /** `offscreen`: render the page offscreen at `frameRate` (see WorkerPool). */
  constructor({ offscreen = false, frameRate = 240 } = {}) {
    this.offscreen = offscreen
    this.frameRate = frameRate
    this.win = null
    this.ready = null
    this.inflight = 0
    this.closed = false
    this.lastReply = 0
  }

  start() {
    // After destroy() (the app is quitting) never open a window again: a new window would keep
    // the app alive with nothing on screen.
    if (this.closed) return Promise.reject(new Error('worker closed'))
    if (this.win && !this.win.isDestroyed()) return this.ready
    this.win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'worker.cjs'),
        // Shell thumbnails need COM, which the Chromium sandbox blocks, and frames are read from
        // local file:// videos into a canvas. The page is an empty local file that never
        // navigates or loads remote content, so only our own preload code runs here.
        sandbox: false,
        webSecurity: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        ...(this.offscreen ? { offscreen: true } : {}),
      },
    })
    const win = this.win
    byContents.set(win.webContents, this)
    // Video fingerprints play videos (fast, muted): nothing from these windows should ever be heard.
    win.webContents.setAudioMuted(true)
    if (this.offscreen) win.webContents.setFrameRate(this.frameRate)
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.on('render-process-gone', () => this.reset(win))
    win.on('closed', () => this.reset(win))
    this.ready = win.loadFile(path.join(__dirname, 'worker.html'))
    return this.ready
  }

  /** `win` is gone (or being closed): its jobs answer null. Jobs already on a newer window go on. */
  reset(win) {
    for (const [key, job] of pending) {
      if (job.worker !== this || job.win !== win) continue
      pending.delete(key)
      clearTimeout(job.timer)
      job.resolve(null)
    }
    if (this.win === win) this.win = null
    if (!win.isDestroyed()) win.destroy()
  }

  /**
   * A job timed out and the window hasn't answered anything all that time: its page is stuck, e.g.
   * in a Windows thumbnail call that never returns (a file on a network share that went away).
   * It's closed; the next job starts a fresh one.
   */
  restart(win) {
    if (win.isDestroyed() || this.win !== win) return
    try {
      win.webContents.forcefullyCrashRenderer() // a stuck page may not close on its own
    } catch {}
    this.reset(win)
  }

  /**
   * Resolves to the worker's reply ({ data, duration } for thumbnails) or null on failure /
   * timeout / cancel. Options: `signal` (AbortSignal) cancels the job; `onProgress(fraction)` is
   * called for jobs that report progress, and each report restarts the timeout.
   */
  async run(job, timeoutMs = 20_000, { signal, onProgress } = {}) {
    if (signal?.aborted) return null
    // counted once, given back exactly once however the job ends
    this.inflight++
    let counted = true
    const release = () => {
      if (!counted) return
      counted = false
      this.inflight = Math.max(0, this.inflight - 1)
    }
    try {
      await this.start()
    } catch {
      release()
      return null
    }
    return new Promise((resolve) => {
      const id = ++seq
      const win = this.win
      if (!win || win.isDestroyed()) {
        // closed while starting (the app is quitting)
        release()
        return resolve(null)
      }
      const finish = (msg) => {
        signal?.removeEventListener('abort', cancel)
        release()
        resolve(msg)
      }
      // Timed out or cancelled: answer null now and tell the worker to stop.
      const expire = (timedOut) => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        clearTimeout(entry.timer)
        // (no answer of any kind from the window since this job's clock started: stuck)
        const stuck = timedOut && Date.now() - Math.max(this.lastReply, entry.since) >= entry.timeoutMs - 100
        if (!win.isDestroyed()) win.webContents.send('worker:cancel', id)
        finish(null)
        if (stuck) this.restart(win)
      }
      const timeout = () => expire(true)
      const cancel = () => expire(false)
      pending.set(id, { resolve: finish, timer: setTimeout(timeout, timeoutMs), worker: this, win, contents: win.webContents, since: Date.now(), expire: timeout, timeoutMs, onProgress })
      signal?.addEventListener('abort', cancel)
      win.webContents.send('worker:job', { ...job, seq: id })
    })
  }

  destroy() {
    this.closed = true
    if (this.win) this.reset(this.win)
    this.win = null
  }
}

/**
 * A small set of workers; each job goes to the least busy one. `{ offscreen: true }` makes
 * windows that render offscreen: unlike hidden windows they present video frames as they play
 * (requestVideoFrameCallback fires at `frameRate`), which video fingerprints can use.
 */
class WorkerPool {
  constructor(size, options) {
    this.workers = Array.from({ length: size }, () => new MediaWorker(options))
  }

  async run(job, timeoutMs, options) {
    // Windows enlarges a HEIC to whatever size is asked for: never ask for more than it has. Its
    // own size also lets the worker render big sizes quicker (see shellThumb in worker.cjs).
    if (job.type === 'shell' && job.size > 0 && HEIF.test(job.path ?? '')) {
      const own = await heifSize(job.path)
      const long = own ? Math.max(own.width, own.height) : 0
      if (long) job = { ...job, size: Math.min(job.size, long), native: long }
    }
    const worker = this.workers.reduce((a, b) => (b.inflight < a.inflight ? b : a))
    return worker.run(job, timeoutMs, options)
  }

  /**
   * Starts the workers ahead of time: the first jobs don't pay the ~1s launch, and no window is
   * created later while the GPU is busy (Chromium sets up a new window's GPU channel synchronously
   * on the main thread, which stalls it for ~0.5s under load).
   */
  warmUp() {
    for (const w of this.workers) w.start().catch(() => {})
  }

  destroy() {
    for (const w of this.workers) w.destroy()
  }
}

module.exports = { WorkerPool, heifSize }
