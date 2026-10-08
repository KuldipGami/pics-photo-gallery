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
const pending = new Map() // seq -> { resolve, timer, worker, expire, timeoutMs, onProgress }

ipcMain.on('worker:done', (event, msg) => {
  const job = pending.get(msg?.seq)
  if (!job || job.worker.win?.webContents !== event.sender) return
  pending.delete(msg.seq)
  clearTimeout(job.timer)
  job.worker.inflight--
  job.resolve(msg)
})

// Long jobs (video fingerprints) report progress; each report restarts their timeout, so the
// timeout means "no progress for this long" rather than a limit on the whole job.
ipcMain.on('worker:progress', (event, msg) => {
  const job = pending.get(msg?.seq)
  if (!job || job.worker.win?.webContents !== event.sender) return
  clearTimeout(job.timer)
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
    // Video fingerprints play videos (fast, muted): nothing from these windows should ever be heard.
    win.webContents.setAudioMuted(true)
    if (this.offscreen) win.webContents.setFrameRate(this.frameRate)
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.on('render-process-gone', () => this.reset(win))
    win.on('closed', () => this.reset(win))
    this.ready = win.loadFile(path.join(__dirname, 'worker.html'))
    return this.ready
  }

  reset(win) {
    for (const [key, job] of pending) {
      if (job.worker !== this) continue
      pending.delete(key)
      clearTimeout(job.timer)
      job.resolve(null)
    }
    this.inflight = 0
    if (this.win === win) this.win = null
    if (!win.isDestroyed()) win.destroy()
  }

  /**
   * Resolves to the worker's reply ({ data, duration } for thumbnails) or null on failure /
   * timeout / cancel. Options: `signal` (AbortSignal) cancels the job; `onProgress(fraction)` is
   * called for jobs that report progress, and each report restarts the timeout.
   */
  async run(job, timeoutMs = 20_000, { signal, onProgress } = {}) {
    if (signal?.aborted) return null
    this.inflight++
    try {
      await this.start()
    } catch {
      this.inflight--
      return null
    }
    return new Promise((resolve) => {
      const id = ++seq
      const win = this.win
      if (!win || win.isDestroyed()) {
        // closed while starting (the app is quitting)
        this.inflight--
        return resolve(null)
      }
      const finish = (msg) => {
        signal?.removeEventListener('abort', expire)
        resolve(msg)
      }
      // Timed out or cancelled: answer null now and tell the worker to stop.
      const expire = () => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        clearTimeout(entry.timer)
        this.inflight--
        if (win && !win.isDestroyed()) win.webContents.send('worker:cancel', id)
        finish(null)
      }
      pending.set(id, { resolve: finish, timer: setTimeout(expire, timeoutMs), worker: this, expire, timeoutMs, onProgress })
      signal?.addEventListener('abort', expire)
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
