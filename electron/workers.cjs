const path = require('node:path')
const { BrowserWindow, ipcMain } = require('electron')

// Main-process side of the hidden media worker windows (see worker.cjs).

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

  run(job, timeoutMs, options) {
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

module.exports = { WorkerPool }
