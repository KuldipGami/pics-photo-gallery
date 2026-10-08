// Preload for hidden "media worker" windows. Runs thumbnail jobs off the main process:
//  - video: decode a frame with the GPU's hardware video decoder (<video> + createImageBitmap)
//  - shell: Windows Shell / macOS QuickLook thumbnails (HEIC, RAW, …). These calls are synchronous,
//           so they live here instead of blocking the app's main process.
//  - frames: fingerprints of a video's frames for duplicate detection (see below)
const { ipcRenderer, nativeImage } = require('electron')
const sig = require('./signature.cjs')

/** True for (near) single-colour images, e.g. the grey frame Windows returns for some videos. */
function isBlank(img) {
  const bmp = img.resize({ width: 24, height: 24 }).toBitmap()
  let sum = 0
  let sumSq = 0
  const n = bmp.length / 4
  for (let i = 0; i < bmp.length; i += 4) {
    const l = 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2]
    sum += l
    sumSq += l * l
  }
  const mean = sum / n
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean)) < 3
}

/**
 * `native`: the picture's own long side when known (HEIC). Windows is slow to scale a big rendition
 * (12 MP HEIC at 2560: ~3.5 s) but quick at the picture's own size (~2 s), so big renditions are
 * decoded at full size and scaled down here (~0.1 s).
 */
async function shellThumb({ path, size, video, quality = 85, native = 0 }) {
  const full = native > size && size > 1024
  let img = await nativeImage.createThumbnailFromPath(path, { width: full ? native : size, height: full ? native : size })
  if (img.isEmpty() || (video && isBlank(img))) return null
  if (full) {
    const { width, height } = img.getSize()
    const scale = size / Math.max(width, height)
    if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
  }
  return img.toJPEG(quality)
}

/** Dark or flat frames (fade-ins, black leaders) make poor thumbnails. */
function looksBlank(bitmap) {
  const probe = new OffscreenCanvas(16, 16)
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0, 16, 16)
  const px = ctx.getImageData(0, 0, 16, 16).data
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.114 * px[i + 2] + 0.587 * px[i + 1] + 0.299 * px[i]
    sum += l
    sumSq += l * l
  }
  const mean = sum / 256
  return mean < 14 || Math.sqrt(Math.max(0, sumSq / 256 - mean * mean)) < 4
}

function videoFrame({ url, size }) {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    let done = false
    let seeked = false
    let duration

    const finish = (data) => {
      if (done) return
      done = true
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      resolve({ data, duration })
    }
    const grab = async () => {
      try {
        const w = video.videoWidth
        const h = video.videoHeight
        if (!w || !h) return finish(null)
        const scale = Math.min(1, size / Math.max(w, h))
        const bitmap = await createImageBitmap(video, {
          resizeWidth: Math.max(1, Math.round(w * scale)),
          resizeHeight: Math.max(1, Math.round(h * scale)),
          resizeQuality: 'medium',
        })
        // The first frame is free (no seek). Only if it's black/flat, look a bit further in.
        if (!seeked && duration > 0.5 && looksBlank(bitmap)) {
          bitmap.close()
          seeked = true
          video.currentTime = Math.min(1.5, duration / 3)
          return
        }
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        canvas.getContext('2d').drawImage(bitmap, 0, 0)
        bitmap.close()
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
        finish(new Uint8Array(await blob.arrayBuffer()))
      } catch {
        finish(null)
      }
    }
    const timer = setTimeout(() => finish(null), 15_000)

    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) duration = video.duration
    }
    video.onloadeddata = grab
    video.onseeked = () => seeked && grab()
    video.onerror = () => finish(null)
    video.src = url
  })
}

// ---------- frame fingerprints of a video, for duplicate detection (see video-frames.cjs) ----------
//
// Ported from DupeLens' VideoAnalyzer: 6 "summary" frames at duration·(k+0.5)/6 (same-length
// copies) plus "dense" frames every second from 0.5 s, at most 1200 = the first 20 minutes
// (trimmed clips). Each frame is drawn small by the GPU (SAMPLE×SAMPLE, aspect ratio ignored like
// photos), box-averaged into the 72×72 brightness grid and fingerprinted right here, so only 16
// bytes per frame travel back to the main process.
//
// Frames are read by seeking to each target: Chromium decodes forward from the previous key frame
// with the hardware decoder, typically 30–100× faster than real time. Measured alternatives:
// playing at 16× and sampling presented frames (requestVideoFrameCallback) is ~15× real time at
// best, and in a hidden window frames are only presented about once a second, so it reads the
// wrong frames. Only when key frames are far apart (each seek then decodes seconds of video) does
// playing win; then, in a worker that renders offscreen (`play`), the rest is read by playing.
// Playing is also gentler: back-to-back seeks (H.264 especially) make the app's own windows drop
// frames (1080p H.264: ~170 instead of 240 fps), playing at 16× doesn't. So while the user is
// looking at the app (`gentle`), frames are read by playing.

const SAMPLE = 144 // drawn size: 2×2 pixels per grid cell
const EPS = 0.04 // a frame up to 40 ms before a target counts (as in DupeLens)
const SEEK_TIMEOUT = 10_000
const STALL_MS = 8_000 // playing: no new frame for this long = stuck
const PLAY_RATE = 16 // Chromium's maximum
const SWITCH_SPEED = 12 // seeking covers less video than this per second: play instead
const MAX_LAG = 2 // s; frames presented this late mean playback isn't being rendered: seek instead
const EXACT_LAG = 0.1 // s; summary frames must be at least this close to their time

/** Fingerprint (Uint32Array(4)) of the video's current frame. */
function frameReader(size) {
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d', { alpha: false })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const grid = sig.GRID
  const cell = size / grid
  const sums = new Uint32Array(grid * grid)
  const area = cell * cell * 1000
  return (video) => {
    ctx.drawImage(video, 0, 0, size, size)
    const px = ctx.getImageData(0, 0, size, size).data
    sums.fill(0)
    for (let y = 0, i = 0; y < size; y++) {
      const row = Math.floor(y / cell) * grid
      for (let x = 0; x < size; x++, i += 4) sums[row + Math.floor(x / cell)] += 299 * px[i] + 587 * px[i + 1] + 114 * px[i + 2]
    }
    const out = new Uint8Array(grid * grid)
    for (let k = 0; k < out.length; k++) out[k] = Math.floor(sums[k] / area)
    return sig.frameWords(out)
  }
}

/** Resolves true when `event` fires, false on error / timeout / cancel. */
function once(video, event, ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const done = (ok) => {
      clearTimeout(timer)
      video.removeEventListener(event, onEvent)
      video.removeEventListener('error', onError)
      signal.removeEventListener('abort', onError)
      resolve(ok)
    }
    const onEvent = () => done(true)
    const onError = () => done(false)
    const timer = setTimeout(onError, ms)
    video.addEventListener(event, onEvent)
    video.addEventListener('error', onError)
    signal.addEventListener('abort', onError)
  })
}

/** Fingerprint of the frame at `t` seconds, or null. */
async function seekRead(video, t, read, signal) {
  video.currentTime = t
  return (await once(video, 'seeked', SEEK_TIMEOUT, signal)) ? read(video) : null
}

/**
 * Seeks to the next target, then plays the video muted from there and fingerprints the first
 * frame presented at or after each further target (pushed to `frames`, how late it was to
 * `lags`). Resolves to why it stopped: 'done' | 'ended' | 'slow' | 'stalled' | 'cancelled' | 'error'.
 */
async function playFrames(video, targets, frames, lags, read, signal, onFrame) {
  // The first frames after play() arrive late (the pipeline starting up): seek to the first one.
  const first = await seekRead(video, targets[frames.length], read, signal)
  if (!first) return 'error'
  frames.push(first)
  lags.push(0)
  onFrame()
  if (frames.length >= targets.length) return 'done'
  return new Promise((resolve) => {
    let lastFrame = performance.now()
    let settled = false
    const finish = (reason) => {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      video.removeEventListener('ended', onEnded)
      signal.removeEventListener('abort', onAbort)
      video.pause()
      video.playbackRate = 1
      resolve(reason)
    }
    const onFrameShown = (_now, meta) => {
      if (settled) return
      lastFrame = performance.now()
      const t = meta.mediaTime
      if (t + EPS >= targets[frames.length]) {
        if (t - targets[frames.length] > MAX_LAG) return finish('slow')
        const words = read(video)
        // Should playback outrun the display, one frame stands in for every target it passed.
        while (frames.length < targets.length && t + EPS >= targets[frames.length]) {
          lags.push(Math.max(0, t - targets[frames.length]))
          frames.push(words)
        }
        onFrame()
      }
      if (frames.length >= targets.length) return finish('done')
      video.requestVideoFrameCallback(onFrameShown)
    }
    const onEnded = () => setTimeout(() => finish('ended'), 100) // the last frame may still be on its way
    const onAbort = () => finish('cancelled')
    const watchdog = setInterval(() => performance.now() - lastFrame > STALL_MS && finish('stalled'), 500)
    video.addEventListener('ended', onEnded)
    signal.addEventListener('abort', onAbort)
    video.playbackRate = PLAY_RATE
    video.requestVideoFrameCallback(onFrameShown)
    video.play().catch(() => finish('error'))
  })
}

/** Frame fingerprints → bytes, 16 per frame (4 little-endian uint32 words). */
const pack = (frames) => {
  const out = new Uint32Array(frames.length * 4)
  frames.forEach((w, i) => out.set(w, i * 4))
  return new Uint8Array(out.buffer)
}

/**
 * Job { url, count = 6, interval = 1, max = 1200, play = false, gentle = false, size = 144 } →
 * { duration, width, height, summary, dense, stats } with `summary` / `dense` as packed
 * fingerprints, or null when the video can't be decoded. `summary` is null when any of the
 * `count` frames couldn't be read (the video is then only checked for exact copies); `dense` holds
 * the frames read up to the first failure. `play`: this window renders offscreen, so frames may be
 * read by playing; `gentle`: prefer playing (see above).
 */
async function videoFingerprints(job, signal, progress) {
  const { url, count = 6, interval = 1, max = 1200, play = false, gentle = false, size = SAMPLE } = job
  const started = performance.now()
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  video.disableRemotePlayback = true
  // On the page (tiny, practically invisible), so that frames played are actually presented.
  video.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:16px;opacity:0.01;pointer-events:none'
  document.body.append(video)
  try {
    video.src = url
    if (!(await once(video, 'loadeddata', 20_000, signal))) return null
    let duration = video.duration
    if (!Number.isFinite(duration)) {
      // Streamed recordings may not state their length: seeking past the end reveals it.
      video.currentTime = 1e9
      await once(video, 'seeked', SEEK_TIMEOUT, signal)
      duration = video.duration
    }
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth) return null
    const read = frameReader(size)
    const stats = { seeks: 0, playedFrom: -1, reason: '', maxLag: 0, ms: 0 }
    const targets = []
    for (let t = interval / 2; t < duration && targets.length < max; t += interval) targets.push(t)
    const total = targets.length + count
    const frames = []
    const lags = []
    const report = () => progress(Math.min(1, frames.length / total))

    // dense frames
    const denseStart = performance.now()
    while (frames.length < targets.length && !signal.aborted) {
      const k = frames.length
      const slow = k >= 5 && targets[k - 1] < (SWITCH_SPEED * (performance.now() - denseStart)) / 1000
      if (play && stats.playedFrom < 0 && targets.length - k >= 10 && (gentle || slow)) {
        stats.playedFrom = k
        stats.reason = await playFrames(video, targets, frames, lags, read, signal, report)
        continue // anything left (the last frames after 'ended', or after a stall) is sought
      }
      const words = await seekRead(video, targets[k], read, signal)
      if (!words) break
      stats.seeks++
      frames.push(words)
      lags.push(0)
      report()
    }
    if (signal.aborted) return null

    // summary frames: the nearest dense frame where there is one (as DupeLens does), else seek
    const summary = []
    for (let k = 0; k < count; k++) {
      const t = (duration * (k + 0.5)) / count
      const nearest = Math.round((t - interval / 2) / interval)
      let words = null
      if (nearest >= 0 && nearest < frames.length) {
        words = frames[nearest]
        // a frame read by playing may be a little late: read it exactly
        if (lags[nearest] > EXACT_LAG) {
          words = (await seekRead(video, targets[nearest], read, signal)) ?? words
          stats.seeks++
        }
      } else {
        words = await seekRead(video, t, read, signal)
        stats.seeks++
      }
      if (!words) break
      summary.push(words)
      progress(Math.min(1, (frames.length + summary.length) / total))
    }
    if (signal.aborted) return null
    stats.maxLag = +Math.max(0, ...lags).toFixed(3)
    stats.ms = Math.round(performance.now() - started)
    return {
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      summary: summary.length === count ? pack(summary) : null,
      dense: frames.length ? pack(frames) : null,
      stats,
    }
  } finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.remove()
  }
}

const cancels = new Map() // seq -> AbortController
ipcRenderer.on('worker:cancel', (_event, seq) => cancels.get(seq)?.abort())

ipcRenderer.on('worker:job', async (_event, job) => {
  const result = { seq: job.seq, data: null }
  try {
    if (job.type === 'video') Object.assign(result, await videoFrame(job))
    else if (job.type === 'frames') {
      const controller = new AbortController()
      cancels.set(job.seq, controller)
      let last = 0
      const progress = (fraction) => {
        const now = performance.now()
        if (now - last < 1000) return
        last = now
        ipcRenderer.send('worker:progress', { seq: job.seq, fraction })
      }
      try {
        result.data = await videoFingerprints(job, controller.signal, progress)
      } finally {
        cancels.delete(job.seq)
      }
    } else result.data = await shellThumb(job)
  } catch {}
  ipcRenderer.send('worker:done', result)
})
