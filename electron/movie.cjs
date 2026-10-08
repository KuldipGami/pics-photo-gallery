const os = require('node:os')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const sharp = require('sharp')
const { run, probe, encoders, encoderArgs, FfmpegError, Canceled, TONEMAP } = require('./ffmpeg.cjs')

/**
 * Memory movies: a set of photos (and short video clips) → an MP4 slideshow with a gentle
 * Ken Burns zoom / pan on each photo, crossfades, a title over the first photo, optional music
 * (looped or cut to length, faded out, lowered while a clip's own sound plays).
 *
 * How it renders: photos are prepared once with sharp (upright, cropped to the movie's shape with
 * room to zoom; portrait photos sit on a blurred copy of themselves). Each frame is then drawn by
 * a pool of worker threads straight in YUV 4:2:0 with sub-pixel bilinear sampling (no jitter),
 * clip frames come from ffmpeg already shaped to the movie, and the frames are piped to ffmpeg
 * for the graphics card's H.264 encoder. The sound is mixed separately and muxed in at the end.
 */

const FPS = 30
const HEADROOM = 1.15 // photos are prepared this much larger than the movie: room to zoom in sharply
const ZOOM = 1.12 // how far a zoom goes (≤ HEADROOM)
const PAN_ZOOM = 1.08 // zoom while panning
const FADE = 0.8 // crossfade (s)
const TITLE_EXTRA = 1.5 // the first photo stays longer under the title (s)
const START_FADE = 0.6
const END_FADE = 1.2
const DUCK = 0.25 // music level while a clip's sound plays
const SIZES = { 1080: [1920, 1080], 720: [1280, 720] }
const BITRATES = { 1080: 10_000_000, 720: 5_000_000 }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0))
const even = (n) => Math.max(2, Math.round(n / 2) * 2)
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))

function cleanOptions(o = {}) {
  const size = Number(o.size) === 720 ? 720 : 1080
  let [W, H] = SIZES[size]
  if (o.shape === 'portrait') [W, H] = [H, W]
  return {
    W,
    H,
    size,
    photoSeconds: clamp(o.photoSeconds ?? 3.5, 1.5, 10),
    clipSeconds: clamp(o.clipSeconds ?? 5, 1, 30),
    clipAudio: o.clipAudio !== false,
    music: typeof o.music === 'string' && o.music.trim() ? o.music : null,
    musicVolume: clamp(o.musicVolume ?? 0.8, 0, 1),
    title: String(o.title ?? '').trim().slice(0, 120),
    subtitle: String(o.subtitle ?? '').trim().slice(0, 160),
    date: Number.isFinite(o.date) ? o.date : Date.now(),
  }
}

/** Where a crossfade-joined sequence of `durations` starts each part; and the total length. */
function layout(entries) {
  let t = 0
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const next = entries[i + 1]
    e.start = t
    e.fadeIn ??= 0
    e.fadeOut = next ? Math.min(FADE, e.dur / 3, next.dur / 3) : 0
    if (next) next.fadeIn = e.fadeOut
    t += e.dur - e.fadeOut
  }
  return t
}

/**
 * How long a movie of these items will be (s), as makeMovie would make it (clip lengths from
 * `item.duration`). For showing "about 1:45" before rendering.
 */
function estimateLength(items, options = {}) {
  const o = cleanOptions(options)
  const entries = items
    .map((it) => (it.type === 'video' ? (it.duration >= 1 ? { dur: Math.min(o.clipSeconds, it.duration) } : null) : { dur: o.photoSeconds }))
    .filter(Boolean)
  if (!entries.length) return 0
  if (o.title) entries[0].dur += TITLE_EXTRA
  return layout(entries)
}

// ---------- photos ----------

/** The interesting point of a photo (0–1), from sharp's attention crop on a small copy. */
async function attentionFocus(small, w, h) {
  try {
    const a = await sharp(small).resize(Math.max(8, Math.round(w * 0.4)), h, { fit: 'cover', position: 'attention' }).toBuffer({ resolveWithObject: true })
    const b = await sharp(small).resize(w, Math.max(8, Math.round(h * 0.4)), { fit: 'cover', position: 'attention' }).toBuffer({ resolveWithObject: true })
    const x = (Math.abs(a.info.cropOffsetLeft || 0) + w * 0.2) / w
    const y = (Math.abs(b.info.cropOffsetTop || 0) + h * 0.2) / h
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
  } catch {
    return { x: 0.5, y: 0.5 }
  }
}

/**
 * A photo, upright, as a raw RGB canvas CW×CH (the movie's shape, HEADROOM larger). Wide-enough
 * photos are cropped around their focus ("cover"); others (portrait on a landscape movie,
 * panoramas) sit whole on a blurred, darkened copy of themselves ("fill"). The file is decoded
 * once. Resolves to { data, w, h, channels, mode, focus } with focus in canvas fractions.
 */
async function preparePhoto(source, { CW, CH, focus }) {
  const meta = await sharp(source, { failOn: 'none' }).metadata()
  const sideways = (meta.orientation || 1) >= 5
  const uw = sideways ? meta.height : meta.width
  const uh = sideways ? meta.width : meta.height
  if (!uw || !uh) throw new Error('No picture')
  const ratio = uw / uh / (CW / CH)
  const rgb = (img) => img.flatten({ background: '#000' }).toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  const rawOf = (r) => ({ raw: { width: r.info.width, height: r.info.height, channels: r.info.channels } })
  if (ratio >= 0.73 && ratio <= 1.45) {
    const scale = Math.max(CW / uw, CH / uh)
    const sw = Math.max(CW, Math.round(uw * scale))
    const sh = Math.max(CH, Math.round(uh * scale))
    const big = await rgb(sharp(source, { failOn: 'none' }).rotate().resize(sw, sh, { fit: 'fill' }))
    let f = focus
    if (!f) {
      const small = await sharp(big.data, rawOf(big)).resize(256, 256, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true })
      f = await attentionFocus(small.data, small.info.width, small.info.height)
    }
    const left = Math.round(clamp(f.x * sw - CW / 2, 0, sw - CW))
    const top = Math.round(clamp(f.y * sh - CH / 2, 0, sh - CH))
    const out = await sharp(big.data, rawOf(big)).extract({ left, top, width: CW, height: CH }).raw().toBuffer({ resolveWithObject: true })
    return { data: out.data, w: CW, h: CH, channels: out.info.channels, mode: 'cover', focus: { x: clamp((f.x * sw - left) / CW, 0, 1), y: clamp((f.y * sh - top) / CH, 0, 1) } }
  }
  // fill: the whole photo over a blurred copy of itself
  const fg = await rgb(sharp(source, { failOn: 'none' }).rotate().resize(CW, CH, { fit: 'inside' }))
  const bgSmall = await sharp(fg.data, rawOf(fg))
    .resize(Math.round(CW / 12), Math.round(CH / 12), { fit: 'cover' })
    .blur(3)
    .modulate({ brightness: 0.55, saturation: 0.85 })
    .png()
    .toBuffer()
  const left = Math.round((CW - fg.info.width) / 2)
  const top = Math.round((CH - fg.info.height) / 2)
  const out = await sharp(bgSmall)
    .resize(CW, CH, { fit: 'fill', kernel: 'linear' })
    .blur(6)
    .composite([{ input: fg.data, raw: rawOf(fg).raw, left, top }])
    .removeAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true })
  const fx = focus ? (left + focus.x * fg.info.width) / CW : 0.5
  const fy = focus ? (top + focus.y * fg.info.height) / CH : 0.5
  return { data: out.data, w: CW, h: CH, channels: out.info.channels, mode: 'fill', focus: { x: fx, y: fy } }
}

/** Ken Burns: the part of the canvas on screen at progress p (0–1), in canvas pixels. */
function viewAt(e, p) {
  const { cw, ch, focus } = e
  const centre = { x: cw / 2, y: ch / 2 }
  const target = { x: focus.x * cw, y: focus.y * ch }
  let z
  let c
  const lerp = (a, b, k) => a + (b - a) * k
  const maxZoom = e.mode === 'fill' ? 1.06 : ZOOM
  switch (e.motion) {
    case 'in':
      z = Math.pow(maxZoom, p)
      c = { x: lerp(centre.x, target.x, p), y: lerp(centre.y, target.y, p) }
      break
    case 'out':
      z = Math.pow(maxZoom, 1 - p)
      c = { x: lerp(target.x, centre.x, p), y: lerp(target.y, centre.y, p) }
      break
    default: {
      z = PAN_ZOOM
      const vw = cw / z
      const vh = ch / z
      const k = e.motion === 'left' ? 1 - p : e.motion === 'right' ? p : 0.5
      const m = e.motion === 'up' ? 1 - p : e.motion === 'down' ? p : 0.5
      const horizontal = e.motion === 'left' || e.motion === 'right'
      c = {
        x: horizontal ? vw / 2 + (cw - vw) * k : clamp(target.x, vw / 2, cw - vw / 2),
        y: horizontal ? clamp(target.y, vh / 2, ch - vh / 2) : vh / 2 + (ch - vh) * m,
      }
    }
  }
  const w = cw / z
  const h = ch / z
  return { x: clamp(c.x - w / 2, 0, cw - w), y: clamp(c.y - h / 2, 0, ch - h), w, h }
}

const MOTIONS = ['in', 'right', 'out', 'left', 'in', 'down', 'out', 'right', 'in', 'left', 'out', 'up']

// ---------- title ----------

const escapeMarkup = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The title card overlay: RGBA W×H (white text with a soft shadow on a gentle dark band). */
async function titleOverlay(title, subtitle, W, H) {
  const unit = Math.min(W, H)
  const font = 'Segoe UI Variable Display, Segoe UI, sans-serif'
  const render = async (text, px, weight) =>
    sharp({
      text: {
        text: `<span foreground="white" font_family="${font}" font_weight="${weight}">${escapeMarkup(text)}</span>`,
        font: `sans ${px}`,
        width: Math.round(W * 0.86),
        align: 'centre',
        rgba: true,
        dpi: 72,
        wrap: 'word',
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true })
  const parts = []
  if (title) parts.push(await render(title, Math.round(unit * 0.1), 600))
  if (subtitle) parts.push(await render(subtitle, Math.round(unit * 0.042), 400))
  const gap = Math.round(unit * 0.018)
  const blockH = parts.reduce((s, p) => s + p.info.height, 0) + gap * (parts.length - 1)
  let y = Math.round(H / 2 - blockH / 2)
  const band = Math.round(blockH + unit * 0.3)
  const bandTop = Math.round(H / 2 - band / 2)
  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.5" stop-color="#000" stop-opacity="0.38"/>` +
      `<stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>` +
      `<rect x="0" y="${bandTop}" width="${W}" height="${band}" fill="url(#g)"/></svg>`,
  )
  const layers = [{ input: svg, left: 0, top: 0 }]
  for (const p of parts) {
    const left = Math.round((W - p.info.width) / 2)
    // shadow: the text's own shape, black, blurred
    const shadow = await sharp(p.data).ensureAlpha().linear([0, 0, 0, 0.6], [0, 0, 0, 0]).blur(Math.max(1, unit * 0.006)).png().toBuffer()
    layers.push({ input: shadow, left, top: y + Math.round(unit * 0.003) }, { input: p.data, left, top: y })
    y += p.info.height + gap
  }
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .raw()
    .toBuffer()
}

// ---------- the frame workers ----------

/**
 * Runs in each worker thread (stringified: no outside variables). Draws frames in NV12: the Y
 * plane, then U and V interleaved at half size (what graphics-card encoders take directly).
 */
function workerMain() {
  const { parentPort } = require('node:worker_threads')
  const photos = new Map() // id → { data: Uint8Array (NV12), w, h }
  let title = null // { data: NV12 + alpha (full size) + alpha (half size) }
  const cols = new Map()

  /** RGB(A) → NV12 (BT.709, limited range); with alpha also two alpha planes (full, ½). */
  function toNV12(src, w, h, channels, withAlpha) {
    const n = w * h
    const size = n * 1.5 + (withAlpha ? n * 1.25 : 0)
    const out = new Uint8Array(new SharedArrayBuffer(size))
    const A = n * 1.5
    const AC = n * 2.5
    const cw = w / 2
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        let rs = 0
        let gs = 0
        let bs = 0
        let as = 0
        for (let k = 0; k < 4; k++) {
          const px = x + (k & 1)
          const py = y + (k >> 1)
          const i = (py * w + px) * channels
          const r = src[i]
          const g = src[i + 1]
          const b = src[i + 2]
          const a = withAlpha ? src[i + 3] : 255
          out[py * w + px] = 16 + ((47 * r + 157 * g + 16 * b + 128) >> 8)
          if (withAlpha) out[A + py * w + px] = a
          rs += r * a
          gs += g * a
          bs += b * a
          as += a
        }
        const c = (y >> 1) * cw + (x >> 1)
        if (as) {
          const r = rs / as
          const g = gs / as
          const b = bs / as
          out[n + 2 * c] = 128 + Math.round(-0.1006 * r - 0.3386 * g + 0.4392 * b)
          out[n + 2 * c + 1] = 128 + Math.round(0.4392 * r - 0.3989 * g - 0.0403 * b)
        } else {
          out[n + 2 * c] = 128
          out[n + 2 * c + 1] = 128
        }
        if (withAlpha) out[AC + c] = (as / 4 + 0.5) | 0
      }
    }
    return out
  }

  function columns(key, ow, vx, scale, sw) {
    let c = cols.get(key)
    if (!c || c.x0.length !== ow) cols.set(key, (c = { x0: new Int32Array(ow), fx: new Int32Array(ow) }))
    const max = sw - 1.001
    for (let x = 0; x < ow; x++) {
      let sx = vx + (x + 0.5) * scale - 0.5
      if (sx < 0) sx = 0
      else if (sx > max) sx = max
      const x0 = sx | 0
      c.x0[x] = x0
      c.fx[x] = ((sx - x0) * 256) | 0
    }
    return c
  }

  let row = new Int32Array(8192)

  /**
   * Bilinear resample of a plane's view (vx, vy, vw, vh) into dst, blending when a < 256.
   * `ch` channels interleaved (1: Y, 2: UV); sw and ow count samples per channel. Separable:
   * each output row first mixes its two source rows (only the columns it uses), then samples
   * across that mix.
   */
  function plane(src, sOff, sw, sh, vx, vy, vw, vh, dst, dOff, ow, oh, a, key, ch) {
    const sx = vw / ow
    const sy = vh / oh
    const { x0, fx } = columns(key, ow, vx, sx, sw)
    const first = x0[0]
    const last = Math.min(sw - 1, x0[ow - 1] + 1)
    const span = (last - first + 1) * ch
    if (row.length < span + 2) row = new Int32Array(span + 64)
    const t = row
    const maxY = sh - 1.001
    const ia = 256 - a
    const stride = sw * ch
    for (let y = 0; y < oh; y++) {
      let yy = vy + (y + 0.5) * sy - 0.5
      if (yy < 0) yy = 0
      else if (yy > maxY) yy = maxY
      const y0 = yy | 0
      const fy = ((yy - y0) * 256) | 0
      const gy = 256 - fy
      const r0 = sOff + y0 * stride + first * ch
      const r1 = r0 + stride
      for (let j = 0; j < span; j++) t[j] = src[r0 + j] * gy + src[r1 + j] * fy
      const o = dOff + y * ow * ch
      if (ch === 1) {
        if (a >= 256) {
          for (let x = 0; x < ow; x++) {
            const i = x0[x] - first
            const f = fx[x]
            dst[o + x] = (t[i] * (256 - f) + t[i + 1] * f + 32768) >> 16
          }
        } else {
          for (let x = 0; x < ow; x++) {
            const i = x0[x] - first
            const f = fx[x]
            const v = (t[i] * (256 - f) + t[i + 1] * f + 32768) >> 16
            dst[o + x] = (dst[o + x] * ia + v * a + 128) >> 8
          }
        }
      } else {
        for (let x = 0; x < ow; x++) {
          const i = (x0[x] - first) * 2
          const f = fx[x]
          const g = 256 - f
          const u = (t[i] * g + t[i + 2] * f + 32768) >> 16
          const v = (t[i + 1] * g + t[i + 3] * f + 32768) >> 16
          const k = o + x * 2
          if (a >= 256) {
            dst[k] = u
            dst[k + 1] = v
          } else {
            dst[k] = (dst[k] * ia + u * a + 128) >> 8
            dst[k + 1] = (dst[k + 1] * ia + v * a + 128) >> 8
          }
        }
      }
    }
  }

  function drawPhoto(dst, W, H, p, view, a) {
    plane(p.data, 0, p.w, p.h, view.x, view.y, view.w, view.h, dst, 0, W, H, a, 'y', 1)
    const half = (v) => v / 2
    plane(p.data, p.w * p.h, p.w / 2, p.h / 2, half(view.x), half(view.y), half(view.w), half(view.h), dst, W * H, W / 2, H / 2, a, 'c', 2)
  }

  function drawRaw(dst, raw, a) {
    if (a >= 256) return dst.set(raw)
    const ia = 256 - a
    for (let i = 0; i < dst.length; i++) dst[i] = (dst[i] * ia + raw[i] * a + 128) >> 8
  }

  function drawTitle(dst, W, H, f) {
    const k = Math.round(f * 256)
    if (k <= 0 || !title) return
    const n = W * H
    const { data } = title
    const A = n * 1.5
    const AC = n * 2.5
    for (let i = 0; i < n; i++) {
      const al = data[A + i]
      if (!al) continue
      const a = ((al + (al >> 7)) * k) >> 8
      dst[i] = (dst[i] * (256 - a) + data[i] * a + 128) >> 8
    }
    const q = n / 4
    for (let c = 0; c < q; c++) {
      const al = data[AC + c]
      if (!al) continue
      const a = ((al + (al >> 7)) * k) >> 8
      const u = n + 2 * c
      dst[u] = (dst[u] * (256 - a) + data[u] * a + 128) >> 8
      dst[u + 1] = (dst[u + 1] * (256 - a) + data[u + 1] * a + 128) >> 8
    }
  }

  function fadeToBlack(dst, W, H, f) {
    const k = Math.round(f * 256)
    if (k >= 256) return
    const n = W * H
    for (let i = 0; i < n; i++) dst[i] = 16 + (((dst[i] - 16) * k) >> 8)
    for (let i = n; i < dst.length; i++) dst[i] = 128 + (((dst[i] - 128) * k) >> 8)
  }

  parentPort.on('message', (m) => {
    try {
      if (m.type === 'convert') {
        const data = toNV12(new Uint8Array(m.rgb), m.w, m.h, m.channels, !!m.alpha)
        parentPort.postMessage({ type: 'converted', id: m.id, sab: data.buffer })
      } else if (m.type === 'photo') {
        photos.set(m.id, { data: new Uint8Array(m.sab), w: m.w, h: m.h })
      } else if (m.type === 'drop') {
        photos.delete(m.id)
      } else if (m.type === 'title') {
        title = { data: new Uint8Array(m.sab) }
      } else if (m.type === 'frame') {
        const { W, H } = m
        const out = new Uint8Array(m.out || new ArrayBuffer(W * H * 1.5))
        let first = true
        for (const layer of m.layers) {
          const a = first ? 256 : Math.max(0, Math.min(256, Math.round(layer.a * 256)))
          if (layer.raw) drawRaw(out, new Uint8Array(layer.raw), a)
          else {
            const p = photos.get(layer.photo)
            if (p) drawPhoto(out, W, H, p, layer.view, a)
            else if (first) out.fill(16, 0, W * H).fill(128, W * H)
          }
          first = false
        }
        if (first) out.fill(16, 0, W * H).fill(128, W * H)
        if (m.title > 0) drawTitle(out, W, H, m.title)
        if (m.black < 1) fadeToBlack(out, W, H, m.black)
        const back = [out.buffer]
        const raws = m.layers.filter((l) => l.raw).map((l) => l.raw)
        parentPort.postMessage({ type: 'frame', seq: m.seq, out: out.buffer, raws }, [...back, ...raws])
      }
    } catch (err) {
      parentPort.postMessage({ type: 'error', seq: m.seq, id: m.id, message: String(err?.stack || err) })
    }
  })
}

class Pool {
  constructor(size) {
    this.workers = []
    this.load = []
    this.waiting = new Map() // key → { resolve, reject }
    this.failed = null
    for (let i = 0; i < size; i++) {
      const w = new Worker(`(${workerMain.toString()})()`, { eval: true })
      w.on('message', (m) => this.onMessage(i, m))
      w.on('error', (err) => this.fail(err))
      this.workers.push(w)
      this.load.push(0)
    }
  }

  onMessage(i, m) {
    const key = m.type === 'converted' || (m.type === 'error' && m.id != null) ? `c${m.id}` : `f${m.seq}`
    const job = this.waiting.get(key)
    if (!job) return
    this.waiting.delete(key)
    this.load[i]--
    if (m.type === 'error') job.reject(new Error(m.message))
    else job.resolve(m)
  }

  fail(err) {
    this.failed = err
    for (const job of this.waiting.values()) job.reject(err)
    this.waiting.clear()
  }

  /** Sends a job to the least busy worker; resolves to its answer. */
  send(key, message, transfer = []) {
    if (this.failed) return Promise.reject(this.failed)
    let best = 0
    for (let i = 1; i < this.workers.length; i++) if (this.load[i] < this.load[best]) best = i
    this.load[best]++
    return new Promise((resolve, reject) => {
      this.waiting.set(key, { resolve, reject })
      this.workers[best].postMessage(message, transfer)
    })
  }

  broadcast(message) {
    for (const w of this.workers) w.postMessage(message)
  }

  close() {
    for (const w of this.workers) w.terminate().catch(() => {})
  }
}

// ---------- clips ----------

/** ffmpeg filter that turns a clip into movie-shaped frames (blurred fill when it doesn't fit). */
function clipFilter(info, W, H) {
  const v = info.video
  const ratio = v.displayWidth / v.displayHeight / (W / H)
  const pre = [`fps=${FPS}`]
  if (v.hdr) pre.push(TONEMAP)
  pre.push('format=yuv420p')
  const tail = `format=yuv420p,setsar=1,tpad=stop_mode=clone:stop_duration=5[v]`
  if (ratio >= 0.73 && ratio <= 1.45) {
    return `[0:v]${pre.join(',')},scale=w=${W}:h=${H}:force_original_aspect_ratio=increase:out_color_matrix=bt709,crop=${W}:${H},${tail}`
  }
  const sw = even(W / 10)
  const sh = even(H / 10)
  return (
    `[0:v]${pre.join(',')},split[a][b];` +
    `[a]scale=w=${sw}:h=${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},boxblur=4:2,scale=${W}:${H}:flags=bilinear:out_color_matrix=bt709,eq=brightness=-0.12:saturation=0.85[bg];` +
    `[b]scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709[fg];` +
    `[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2,${tail}`
  )
}

/** Reads a clip's excerpt as raw movie frames, one at a time (decoded ahead a little). */
class ClipReader {
  constructor(entry, W, H, signal) {
    this.size = W * H * 1.5
    this.frames = []
    this.wanted = []
    this.ended = false
    this.last = null
    this.partial = null
    this.filled = 0
    this.abort = new AbortController()
    const kill = () => this.abort.abort()
    signal?.addEventListener('abort', kill, { once: true })
    const count = Math.ceil(entry.dur * FPS) + 3
    const args = ['-v', 'error', '-ss', entry.offset.toFixed(3), '-t', (entry.dur + 1).toFixed(3), '-i', entry.path, '-an', '-sn', '-dn']
    args.push('-filter_complex', clipFilter(entry.info, W, H), '-map', '[v]', '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'nv12', 'pipe:1')
    run(args, { stdout: 'stream', signal: this.abort.signal, idleTimeout: 60_000, onSpawn: (child) => this.attach(child) })
      .catch(() => {})
      .finally(() => {
        signal?.removeEventListener('abort', kill)
        this.ended = true
        this.flush()
      })
  }

  attach(child) {
    this.child = child
    child.stdout.on('data', (chunk) => {
      let pos = 0
      while (pos < chunk.length) {
        if (!this.partial) {
          this.partial = Buffer.allocUnsafeSlow(this.size)
          this.filled = 0
        }
        const n = Math.min(chunk.length - pos, this.size - this.filled)
        chunk.copy(this.partial, this.filled, pos, pos + n)
        this.filled += n
        pos += n
        if (this.filled === this.size) {
          this.frames.push(this.partial)
          this.partial = null
        }
      }
      if (this.frames.length >= 8) child.stdout.pause()
      this.flush()
    })
  }

  flush() {
    while (this.wanted.length && (this.frames.length || this.ended)) {
      const resolve = this.wanted.shift()
      resolve(this.take())
    }
    if (this.frames.length < 4) this.child?.stdout.resume()
  }

  take() {
    const f = this.frames.shift()
    if (f) {
      if (!this.frames.length) this.last = Buffer.from(f) // f itself is handed to a worker
      return f
    }
    // the clip ran out (or couldn't be read): hold its last frame, else black
    if (this.last) return Buffer.from(this.last)
    const black = Buffer.allocUnsafeSlow(this.size)
    const n = (this.size / 3) * 2
    black.fill(16, 0, n).fill(128, n)
    return black
  }

  /** The next frame (a Buffer of its own, safe to transfer). */
  next() {
    if (this.frames.length || this.ended) {
      const f = this.take()
      if (this.frames.length < 4) this.child?.stdout.resume()
      return Promise.resolve(f)
    }
    return new Promise((resolve) => {
      this.wanted.push(resolve)
      this.child?.stdout.resume()
    })
  }

  close() {
    this.abort.abort()
  }
}

// ---------- sound ----------

/**
 * Mixes the movie's sound into an AAC file: the music (looped / cut to length, faded in and out,
 * lowered under clips that have their own sound) and those clips' sound at their places.
 * Resolves to the file, or null when the movie is silent.
 */
async function mixSound({ entries, total, opt, dir, signal }) {
  const clips = opt.clipAudio ? entries.filter((e) => e.kind === 'clip' && e.info.audio) : []
  if (!opt.music && !clips.length) return null
  const out = path.join(dir, 'sound.m4a')
  const args = ['-v', 'error']
  const graph = []
  let n = 0
  const fmt = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
  let music = null
  if (opt.music) {
    args.push('-stream_loop', '-1', '-t', (total + 1).toFixed(3), '-i', opt.music)
    const k = n++
    // lowered while a clip with sound plays (with 0.4 s ramps)
    let duck = '0'
    for (const e of clips) {
      const a = e.start.toFixed(3)
      const b = (e.start + e.dur).toFixed(3)
      duck = `max(${duck},clip(min((t-${a})/0.4,(${b}-t)/0.4),0,1))`
    }
    const fadeOut = Math.min(3, total / 3)
    graph.push(
      `[${k}:a]${fmt},atrim=0:${total.toFixed(3)},volume=${opt.musicVolume.toFixed(3)},` +
        (clips.length ? `volume='1-${(1 - DUCK).toFixed(2)}*${duck}':eval=frame,` : '') +
        `afade=t=in:d=${Math.min(1, total / 4).toFixed(2)},afade=t=out:st=${(total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[m]`,
    )
    music = '[m]'
  }
  const parts = []
  for (const e of clips) {
    args.push('-ss', e.offset.toFixed(3), '-t', e.dur.toFixed(3), '-i', e.path)
    const k = n++
    const ms = Math.round(e.start * 1000)
    const fin = Math.min(0.3, e.dur / 4)
    graph.push(
      `[${k}:a]${fmt},asetpts=PTS-STARTPTS,afade=t=in:d=${fin.toFixed(2)},afade=t=out:st=${Math.max(0, e.dur - 0.4).toFixed(3)}:d=0.4,adelay=${ms}|${ms}[c${k}]`,
    )
    parts.push(`[c${k}]`)
  }
  let clipBus = null
  if (parts.length === 1) clipBus = parts[0]
  else if (parts.length > 1) {
    graph.push(`${parts.join('')}amix=inputs=${parts.length}:normalize=0:dropout_transition=0[cl]`)
    clipBus = '[cl]'
  }
  if (music && clipBus) graph.push(`${music}${clipBus}amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]`)
  else if (music) graph.push(`${music}anull[a]`)
  else graph.push(`${clipBus}apad,atrim=0:${total.toFixed(3)},alimiter=limit=0.95[a]`)
  const script = path.join(dir, 'sound.txt')
  await fsp.writeFile(script, graph.join(';\n'))
  args.push('-filter_complex_script', script, '-map', '[a]', '-t', total.toFixed(3))
  // Windows' own AAC encoder is several times faster than ffmpeg's; ffmpeg's is the fallback
  try {
    await run([...args, '-c:a', 'aac_mf', '-b:a', '192k', '-y', out], { signal, idleTimeout: 120_000 })
  } catch (err) {
    if (err instanceof Canceled) throw err
    await run([...args, '-c:a', 'aac', '-b:a', '192k', '-y', out], { signal, idleTimeout: 120_000 })
  }
  return out
}

// ---------- the movie ----------

/**
 * Makes the movie. `options`:
 *   items        [{ type: 'image' | 'video', path, name?, duration?, focus?: { x, y } (0–1, e.g.
 *                the middle of the faces) }] in movie order
 *   getSource    (item) → path or image buffer for a photo (default: item.path); HEIC etc. are
 *                decoded by the caller
 *   output       the .mp4 to write (replaced if it exists)
 *   title, subtitle   the title card ("Goa", "March 2023"); none when both are empty
 *   photoSeconds (3.5), clipSeconds (5), clipAudio (true: clips keep their sound, music lowered)
 *   music        an audio file (or null); musicVolume 0–1
 *   size         1080 | 720;  shape 'landscape' | 'portrait'
 *   date         creation time stored in the file (ms; default now)
 * `onProgress({ phase: 'preparing' | 'rendering' | 'finishing', fraction, done, total, fps })`,
 * `signal` cancels. Resolves to { file, duration, frames, encoder, seconds, skipped: [names] }.
 */
async function makeMovie(options, { onProgress, signal } = {}) {
  const t0 = Date.now()
  const opt = cleanOptions(options)
  const { W, H } = opt
  const items = Array.isArray(options.items) ? options.items.filter((it) => it && it.path) : []
  if (!items.length) throw new FfmpegError('Choose some photos or videos for the movie')
  let output = String(options.output || '')
  if (!output) throw new FfmpegError('Choose where to save the movie')
  if (!/\.mp4$/i.test(output)) output += '.mp4'
  const getSource = options.getSource || ((it) => it.path)
  if (signal?.aborted) throw new Canceled()

  const abort = new AbortController()
  const onAbort = () => abort.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const sig = abort.signal
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-movie-'))
  let pool = null
  const readers = new Map()
  const report = throttle(onProgress)
  const skipped = []

  try {
    // 1. the plan: clips are probed (quick); photos are read later, while the movie renders
    const CW = even(W * HEADROOM)
    const CH = even(H * HEADROOM)
    const encoderList = encoders() // checked in parallel
    if (opt.music) {
      const m = await probe(opt.music, { signal: sig }).catch(() => null)
      if (sig.aborted) throw new Canceled()
      if (!m?.audio) throw new FfmpegError("This music file can't be played — choose another one")
    }
    const entries = new Array(items.length)
    const clipCount = items.filter((it) => it.type === 'video').length
    let probed = 0
    let photoNo = 0
    // a quick look that the photos are still there (they are read for real while rendering)
    const present = await Promise.all(items.map((it) => (it.type === 'video' ? true : fsp.access(it.path).then(() => true, () => false))))
    items.forEach((it, i) => {
      if (it.type !== 'video' && !present[i]) skipped.push(it.name || path.basename(it.path))
      else if (it.type !== 'video') {
        const focus = it.focus && Number.isFinite(it.focus.x) && Number.isFinite(it.focus.y) ? { x: clamp(it.focus.x, 0, 1), y: clamp(it.focus.y, 0, 1) } : null
        entries[i] = { kind: 'photo', item: it, name: it.name || path.basename(it.path), dur: opt.photoSeconds, cw: CW, ch: CH, given: focus, focus: { x: 0.5, y: 0.5 }, mode: 'cover', motion: 'in', ordinal: photoNo++ }
      }
    })
    await mapLimit(items, 4, async (it, i) => {
      if (it.type !== 'video' || sig.aborted) return
      const name = it.name || path.basename(it.path)
      try {
        const info = await probe(it.path, { signal: sig })
        const length = info.duration || it.duration || 0
        if (!info.video || length < 0.8) throw new Error('No usable picture')
        const dur = Math.min(opt.clipSeconds, length)
        // long clips: an excerpt from a little way in (the first moments are often shaky)
        const offset = length > dur ? Math.min((length - dur) * 0.3, 10) : 0
        entries[i] = { kind: 'clip', path: it.path, name, info, dur, offset }
      } catch {
        if (!sig.aborted) skipped.push(name)
      }
      probed++
      report({ phase: 'preparing', fraction: 0.02 * (probed / clipCount), done: probed, total: clipCount })
    })
    if (sig.aborted) throw new Canceled()
    const list = entries.filter(Boolean)
    if (!list.length) throw new FfmpegError('None of these photos or videos could be opened')
    if (opt.title || opt.subtitle) list[0].dur += TITLE_EXTRA
    const total = layout(list)
    const frames = Math.max(1, Math.round(total * FPS))
    list.forEach((e, i) => (e.index = i))
    report({ phase: 'preparing', fraction: 0.02, done: clipCount, total: clipCount }, true)

    // 2. sound (in the background while the pictures render)
    const sound = mixSound({ entries: list, total, opt, dir, signal: sig })
    sound.catch(() => {})

    // 3. pictures
    const cores = os.availableParallelism?.() ?? os.cpus().length
    pool = new Pool(Math.max(2, Math.min(16, cores - 4)))
    if (opt.title || opt.subtitle) {
      const rgba = await titleOverlay(opt.title, opt.subtitle, W, H)
      const ab = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.length)
      const res = await pool.send('ctitle', { type: 'convert', id: 'title', rgb: ab, w: W, h: H, channels: 4, alpha: true }, [ab])
      pool.broadcast({ type: 'title', sab: res.sab })
    }
    const first = list[0]
    const titleEnd = first.start + first.dur - first.fadeOut - 0.3
    const titleAt = (t) => (!opt.title && !opt.subtitle ? 0 : smooth((t - 0.3) / 0.8) * smooth((titleEnd - t) / 0.6))

    // Photos are read a few ahead of the frame being drawn, a few at a time, in movie order.
    const lanes = limiter(Math.max(2, Math.min(6, Math.round(cores / 4))))
    const canvases = new Map() // entry index → Promise (canvas sent to the workers)
    const loadCanvas = (e) => {
      let p = canvases.get(e.index)
      if (!p) {
        p = lanes(async () => {
          if (sig.aborted) return
          try {
            const source = await getSource(e.item)
            if (!source) throw new Error('No picture')
            const res = await preparePhoto(source, { CW, CH, focus: e.given })
            e.mode = res.mode
            e.focus = res.focus
            const d = res.data
            const ab = d.buffer.slice(d.byteOffset, d.byteOffset + d.length) // sharp's memory can't be handed over
            const conv = await pool.send(`c${e.index}`, { type: 'convert', id: e.index, rgb: ab, w: res.w, h: res.h, channels: res.channels }, [ab])
            pool.broadcast({ type: 'photo', id: e.index, sab: conv.sab, w: res.w, h: res.h })
          } catch {
            // unreadable after all: its place stays dark
            if (!sig.aborted && !e.failed) skipped.push(e.name)
            e.failed = true
          }
          e.motion = e.mode === 'fill' ? (e.ordinal % 2 ? 'out' : 'in') : MOTIONS[e.ordinal % MOTIONS.length]
        })
        canvases.set(e.index, p)
      }
      return p
    }
    const reader = (e) => {
      let r = readers.get(e.index)
      if (!r) readers.set(e.index, (r = new ClipReader(e, W, H, sig)))
      return r
    }

    const tryEncoders = (await encoderList).h264
    let encoder = null
    let lastError = null
    let attempt = 0
    const videoFile = path.join(dir, 'video.mp4')
    for (const name of tryEncoders) {
      try {
        await renderFrames(name)
        encoder = name
        break
      } catch (err) {
        if (err instanceof Canceled || sig.aborted) throw new Canceled()
        if (!(err && err.early)) throw err
        lastError = err // this encoder wouldn't start: start again with the next one
      }
    }
    if (!encoder) throw lastError || new FfmpegError("The movie couldn't be encoded")

    async function renderFrames(encoderName) {
      // fresh state for each attempt
      attempt++
      for (const r of readers.values()) r.close()
      readers.clear()
      const free = []
      let child = null
      let written = 0
      let exited = false
      const enc = run(
        [
          '-v', 'error',
          '-f', 'rawvideo', '-pix_fmt', 'nv12', '-s', `${W}x${H}`, '-r', String(FPS), '-blocksize', String(W * H * 1.5),
          '-i', 'pipe:0', '-an',
          ...encoderArgs(encoderName, { bitrate: BITRATES[opt.size], gop: FPS * 2, fast: true, input: 'nv12' }),
          '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
          '-f', 'mp4', '-y', videoFile,
        ],
        { stdin: true, signal: sig, idleTimeout: 0, onSpawn: (c) => (child = c) },
      )
      enc.catch(() => {}).finally(() => (exited = true))
      const encFailed = enc.then(
        () => {
          throw new FfmpegError('The encoder stopped early')
        },
        (err) => {
          if (written < FPS) err.early = true
          throw err
        },
      )
      encFailed.catch(() => {})

      const window = Math.min(64, pool.workers.length * 4)
      const pending = new Map()
      let next = 0
      let seg = 0 // first entry that may still be on screen (for scheduling)
      let kept = 0 // first entry whose memory is still kept (for frames not yet written)
      const t1 = Date.now()

      /**
       * Works out frame f's layers and sends it to a worker. Synchronous up to the waits, so clip
       * frames are taken in order; resolves to the worker's answer.
       */
      const schedule = (f) => {
        const t = f / FPS
        while (seg < list.length - 1 && t >= list[seg].start + list[seg].dur) seg++
        // get what comes next ready: the next 6 photos, the clips among the next 3 entries
        let ahead = 0
        for (let i = seg; i < list.length && ahead < 6; i++) {
          if (list[i].kind === 'photo') {
            loadCanvas(list[i])
            ahead++
          } else if (i < seg + 3) reader(list[i])
        }
        const parts = []
        for (let i = seg; i < list.length && list[i].start <= t + 1e-9; i++) {
          const e = list[i]
          if (t >= e.start + e.dur) continue
          const local = t - e.start
          const a = e.fadeIn && local < e.fadeIn ? smooth(local / e.fadeIn) : 1
          if (e.kind === 'photo') parts.push({ a, e, p: clamp(local / e.dur, 0, 1), ready: loadCanvas(e) })
          else parts.push({ a, ready: reader(e).next() })
        }
        const black = Math.min(smooth(t / START_FADE), smooth((total - t) / END_FADE))
        const title = titleAt(t)
        return Promise.all(parts.map((p) => p.ready)).then((ready) => {
          const layers = []
          const transfer = []
          parts.forEach((p, k) => {
            if (p.e) {
              // an unreadable photo leaves its place dark
              if (!p.e.failed) layers.push({ photo: p.e.index, view: viewAt(p.e, p.p), a: p.a })
              else if (!layers.length) layers.push({ photo: -1, a: 1 })
            } else {
              const buf = ready[k]
              const ab = buf.byteOffset === 0 && buf.buffer.byteLength === buf.length ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
              layers.push({ raw: ab, a: p.a })
              transfer.push(ab)
            }
          })
          const out = free.pop()
          if (out) transfer.push(out)
          const seq = `${attempt}:${f}`
          return pool.send(`f${seq}`, { type: 'frame', seq, W, H, layers, title, black, out }, transfer)
        })
      }

      while (written < frames) {
        if (sig.aborted) throw new Canceled()
        while (next < frames && next - written < window) {
          const f = next++
          const p = schedule(f)
          p.catch(() => {})
          pending.set(f, p)
        }
        const res = await Promise.race([pending.get(written), encFailed])
        pending.delete(written)
        if (exited) await encFailed
        const buf = Buffer.from(res.out)
        await new Promise((resolve, reject) => {
          const ok = child.stdin.write(buf, (err) => {
            if (!err) free.push(res.out)
          })
          if (ok) return resolve()
          const onDrain = () => {
            cleanup()
            resolve()
          }
          const onGone = () => {
            cleanup()
            encFailed.catch(reject)
          }
          const cleanup = () => {
            child.stdin.off('drain', onDrain)
            child.off('close', onGone)
          }
          child.stdin.on('drain', onDrain)
          child.on('close', onGone)
        })
        written++
        // every frame that needed these is done: free their memory
        const t = written / FPS
        while (kept < list.length - 1 && t >= list[kept].start + list[kept].dur) {
          const old = list[kept++]
          if (old.kind === 'photo' && canvases.has(old.index)) {
            const idx = old.index
            canvases.get(idx).then(() => pool.broadcast({ type: 'drop', id: idx }), () => {})
            canvases.delete(idx)
          } else if (old.kind === 'clip') readers.get(old.index)?.close()
        }
        const secs = (Date.now() - t1) / 1000
        report({ phase: 'rendering', fraction: 0.02 + 0.95 * (written / frames), done: written, total: frames, fps: secs > 0.5 ? written / secs : 0 })
      }
      child.stdin.end()
      await enc
    }

    // 4. sound + pictures → the movie (moov first, so it starts playing at once)
    if (list.every((e) => e.kind === 'photo' && e.failed)) throw new FfmpegError('None of these photos or videos could be opened')
    report({ phase: 'finishing', fraction: 0.97, done: frames, total: frames }, true)
    const audio = await sound.catch((err) => {
      if (sig.aborted) throw new Canceled()
      throw new FfmpegError("The movie's sound couldn't be mixed", err?.detail || String(err?.message || err))
    })
    const part = `${output}.part`
    const meta = ['-metadata', `creation_time=${new Date(opt.date).toISOString()}`, '-metadata', 'comment=Made with Lumen']
    if (opt.title) meta.push('-metadata', `title=${[opt.title, opt.subtitle].filter(Boolean).join(' · ')}`)
    try {
      await run(
        ['-v', 'error', '-i', videoFile, ...(audio ? ['-i', audio] : []), '-map', '0:v', ...(audio ? ['-map', '1:a', '-shortest'] : []), '-c', 'copy', ...meta, '-movflags', '+faststart', '-f', 'mp4', '-y', part],
        { signal: sig },
      )
      await fsp.rename(part, output)
    } catch (err) {
      await fsp.rm(part, { force: true }).catch(() => {})
      throw err
    }
    report({ phase: 'finishing', fraction: 1, done: frames, total: frames }, true)
    return { file: output, duration: total, frames, encoder, seconds: (Date.now() - t0) / 1000, skipped }
  } catch (err) {
    if (sig.aborted || err instanceof Canceled) throw new Canceled()
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
    abort.abort() // stops anything still running (decoders, sound)
    for (const r of readers.values()) r.close()
    pool?.close()
    await new Promise((r) => setTimeout(r, 100)) // let killed processes let go of their files
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
}

/** Runs at most `n` tasks at once, in the order they were asked for. */
function limiter(n) {
  let active = 0
  const queue = []
  const pump = () => {
    while (active < n && queue.length) {
      const { task, resolve, reject } = queue.shift()
      active++
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--
          pump()
        })
    }
  }
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject })
      pump()
    })
}

/** At most ~8 progress reports a second (always the last). */
function throttle(fn) {
  if (!fn) return () => {}
  let last = 0
  return (p, force = false) => {
    const now = Date.now()
    if (!force && now - last < 120 && p.fraction < 1) return
    last = now
    fn(p)
  }
}

async function mapLimit(list, limit, fn) {
  let i = 0
  const lanes = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const k = i++
      await fn(list[k], k)
    }
  })
  await Promise.all(lanes)
}

module.exports = { makeMovie, estimateLength, viewAt, cleanOptions }
