const path = require('node:path')
const { BrowserWindow, ipcMain } = require('electron')

// Main-process side of the hidden media worker windows (see worker.cjs).

let seq = 0
const pending = new Map() // seq -> { resolve, timer, worker }

ipcMain.on('worker:done', (event, msg) => {
  const job = pending.get(msg?.seq)
  if (!job || job.worker.win?.webContents !== event.sender) return
  pending.delete(msg.seq)
  clearTimeout(job.timer)
  job.worker.inflight--
  job.resolve(msg)
})

class MediaWorker {
  constructor() {
    this.win = null
    this.ready = null
    this.inflight = 0
  }

  start() {
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
      },
    })
    const win = this.win
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

  /** Resolves to { data, duration } or null on failure / timeout. */
  async run(job, timeoutMs = 20_000) {
    this.inflight++
    try {
      await this.start()
    } catch {
      this.inflight--
      return null
    }
    return new Promise((resolve) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        this.inflight--
        resolve(null)
      }, timeoutMs)
      pending.set(id, { resolve, timer, worker: this })
      this.win.webContents.send('worker:job', { ...job, seq: id })
    })
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}

/** A small set of workers; each job goes to the least busy one. */
class WorkerPool {
  constructor(size) {
    this.workers = Array.from({ length: size }, () => new MediaWorker())
  }

  run(job, timeoutMs) {
    const worker = this.workers.reduce((a, b) => (b.inflight < a.inflight ? b : a))
    return worker.run(job, timeoutMs)
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
