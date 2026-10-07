// Preload for hidden "media worker" windows. Runs thumbnail jobs off the main process:
//  - video: decode a frame with the GPU's hardware video decoder (<video> + createImageBitmap)
//  - shell: Windows Shell / macOS QuickLook thumbnails (HEIC, RAW, …). These calls are synchronous,
//           so they live here instead of blocking the app's main process.
const { ipcRenderer, nativeImage } = require('electron')

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

async function shellThumb({ path, size, video, quality = 85 }) {
  const img = await nativeImage.createThumbnailFromPath(path, { width: size, height: size })
  if (img.isEmpty() || (video && isBlank(img))) return null
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

ipcRenderer.on('worker:job', async (_event, job) => {
  const result = { seq: job.seq, data: null }
  try {
    if (job.type === 'video') Object.assign(result, await videoFrame(job))
    else result.data = await shellThumb(job)
  } catch {}
  ipcRenderer.send('worker:done', result)
})
