const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')
const { cleanSteps, makeStep } = require('./eraser.cjs')

/**
 * Photo edits, always saved as a new file next to the original (the original is never changed).
 *
 * An edit is a small recipe applied in this order:
 *   erase      magic eraser steps, on the upright photo (see eraser.cjs) — first, so what was
 *              brushed stays on the object whatever is turned or cropped later
 *   quarter    clockwise quarter turns (0–3)
 *   flip       mirror left↔right (after turning, as seen on screen)
 *   straighten small rotation in degrees (−45…45); the empty corners are cropped away
 *   crop       {x, y, w, h} as fractions of the straightened picture
 *   enhance    automatic levels + a little colour
 *   light, contrast, color, warmth   −1…1
 * The preview runs the same recipe on a smaller copy, so what you see is what gets saved.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0))
const RAD = Math.PI / 180

function cleanRecipe(r = {}) {
  const crop = r.crop && typeof r.crop === 'object' ? r.crop : null
  return {
    quarter: ((Math.round(Number(r.quarter) || 0) % 4) + 4) % 4,
    flip: !!r.flip,
    straighten: clamp(r.straighten, -45, 45),
    crop: crop
      ? {
          x: clamp(crop.x, 0, 1),
          y: clamp(crop.y, 0, 1),
          w: clamp(crop.w, 0.01, 1),
          h: clamp(crop.h, 0.01, 1),
        }
      : null,
    enhance: !!r.enhance,
    light: clamp(r.light, -1, 1),
    contrast: clamp(r.contrast, -1, 1),
    color: clamp(r.color, -1, 1),
    warmth: clamp(r.warmth, -1, 1),
    erase: cleanSteps(r.erase),
  }
}

const isIdentity = (r) =>
  !r.quarter && !r.flip && !r.straighten && !r.crop && !r.enhance && !r.light && !r.contrast && !r.color && !r.warmth && !r.erase.length

/** Largest centred rectangle with the picture's proportions that fits after rotating by `deg`. */
function inscribed(w, h, deg) {
  const a = Math.abs(deg) * RAD
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const s = Math.min(w / (w * cos + h * sin), h / (w * sin + h * cos))
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)) }
}

/**
 * Where a point of the picture as shown while editing (turned, flipped and straightened, not yet
 * cropped; fractions of it) is on the upright W0×H0 photo (fractions). `scale` turns a length as a
 * fraction of the shown picture's long side into a fraction of the photo's long side.
 */
function fromView(recipe, W0, H0) {
  const r = cleanRecipe(recipe)
  const odd = r.quarter % 2 === 1
  const W1 = odd ? H0 : W0
  const H1 = odd ? W0 : H0
  const fit = r.straighten ? inscribed(W1, H1, r.straighten) : { w: W1, h: H1 }
  const cos = Math.cos(-r.straighten * RAD)
  const sin = Math.sin(-r.straighten * RAD)
  const map = (fx, fy) => {
    // undo the straightening (a clockwise turn about the centre), then the mirror
    const dx = fx * fit.w - fit.w / 2
    const dy = fy * fit.h - fit.h / 2
    let x = dx * cos - dy * sin + W1 / 2
    let y = dx * sin + dy * cos + H1 / 2
    if (r.flip) x = W1 - x
    // undo the quarter turns: a clockwise turn moves (x, y) of a w×h picture to (h − y, x)
    let w = W1
    let h = H1
    for (let q = 0; q < r.quarter; q++) {
      ;[x, y] = [y, w - x]
      ;[w, h] = [h, w]
    }
    return [x / W0, y / H0]
  }
  return { map, scale: Math.max(fit.w, fit.h) / Math.max(W0, H0) }
}

/**
 * The photo upright (EXIF orientation), optionally shrunk to `maxSize`, as raw pixels. Transparency
 * is dropped unless `alpha` (for saving as PNG, WebP, AVIF or TIFF, which keep it).
 */
function decode(input, maxSize, { alpha = false } = {}) {
  let img = sharp(input, { failOn: 'none' }).rotate()
  if (maxSize) img = img.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
  if (!alpha) img = img.removeAlpha()
  return img.raw().toBuffer({ resolveWithObject: true })
}

/** Output formats that can store transparency. */
const ALPHA_FORMATS = new Set(['png', 'webp', 'avif', 'tiff'])

/** Adds the transparency of `input` (upright, full size) back to erased raw RGB pixels. */
async function withAlphaOf(input, img) {
  const { width, height } = img.info
  const mask = await sharp(input, { failOn: 'none' }).rotate().extractChannel('alpha').raw().toBuffer({ resolveWithObject: true })
  if (mask.info.width !== width || mask.info.height !== height) return img
  return sharp(img.data, { raw: { width, height, channels: img.info.channels } })
    .joinChannel(mask.data, { raw: { width, height, channels: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true })
}

/**
 * Runs the recipe. `input` is a file path or an image buffer; `maxSize` shrinks the picture first
 * (for previews); `erase(img, steps)` runs the magic eraser steps; `alpha` keeps transparency.
 * Resolves to a sharp pipeline ready for output.
 */
async function apply(input, recipe, maxSize, erase, { alpha = false } = {}) {
  const r = cleanRecipe(recipe)
  let img = await decode(input, maxSize, { alpha })
  if (r.erase.length) {
    if (!erase) throw new Error("The magic eraser isn't available")
    img = await erase(img, r.erase)
  }
  return render(img, r)
}

/** The rest of the recipe (`r`, cleaned), on the upright photo's raw pixels after erasing. */
async function render(upright, r) {
  let { data, info } = upright
  const raw = () => ({ raw: { width: info.width, height: info.height, channels: info.channels } })
  // 1. quarter turns and mirror
  if (r.quarter || r.flip) {
    let step = sharp(data, raw())
    if (r.quarter) step = step.rotate(r.quarter * 90)
    ;({ data, info } = await step.raw().toBuffer({ resolveWithObject: true }))
    if (r.flip) ({ data, info } = await sharp(data, raw()).flop().raw().toBuffer({ resolveWithObject: true }))
  }
  // 2. straighten, then cut away the empty corners
  if (r.straighten) {
    const { width: w, height: h } = info
    ;({ data, info } = await sharp(data, raw())
      .rotate(r.straighten, { background: { r: 0, g: 0, b: 0 } })
      .raw()
      .toBuffer({ resolveWithObject: true }))
    const fit = inscribed(w, h, r.straighten)
    ;({ data, info } = await sharp(data, raw())
      .extract({
        left: Math.max(0, Math.floor((info.width - fit.w) / 2)),
        top: Math.max(0, Math.floor((info.height - fit.h) / 2)),
        width: Math.min(fit.w, info.width),
        height: Math.min(fit.h, info.height),
      })
      .raw()
      .toBuffer({ resolveWithObject: true }))
  }
  // 3. crop
  if (r.crop) {
    const left = Math.round(r.crop.x * info.width)
    const top = Math.round(r.crop.y * info.height)
    const width = Math.max(1, Math.min(info.width - left, Math.round(r.crop.w * info.width)))
    const height = Math.max(1, Math.min(info.height - top, Math.round(r.crop.h * info.height)))
    ;({ data, info } = await sharp(data, raw()).extract({ left, top, width, height }).raw().toBuffer({ resolveWithObject: true }))
  }
  // 4. light & colour
  let out = sharp(data, raw())
  if (r.enhance) out = out.normalise({ lower: 0.5, upper: 99.5 })
  if (r.contrast) {
    const a = 1 + r.contrast * (r.contrast > 0 ? 0.6 : 0.5)
    out = out.linear(a, 128 * (1 - a))
  }
  const brightness = 1 + r.light * 0.45
  const saturation = Math.max(0, 1 + r.color * 0.8 + (r.enhance ? 0.12 : 0))
  if (brightness !== 1 || saturation !== 1) out = out.modulate({ brightness, saturation })
  if (r.warmth) {
    const k = r.warmth * 0.12
    out = out.recomb([
      [1 + k, 0, 0],
      [0, 1 + k * 0.15, 0],
      [0, 0, 1 - k],
    ])
  }
  return out
}

const OUTPUT = { jpg: 'jpeg', jpeg: 'jpeg', jfif: 'jpeg', png: 'png', webp: 'webp', avif: 'avif', tif: 'tiff', tiff: 'tiff' }

function exifDate(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function gpsTags(lat, lon) {
  const dms = (v) => {
    v = Math.abs(v)
    const d = Math.floor(v)
    const m = Math.floor((v - d) * 60)
    const s = Math.round(((v - d) * 60 - m) * 60 * 1000)
    return `${d}/1 ${m}/1 ${s}/1000`
  }
  return { GPSLatitudeRef: lat >= 0 ? 'N' : 'S', GPSLatitude: dms(lat), GPSLongitudeRef: lon >= 0 ? 'E' : 'W', GPSLongitude: dms(lon) }
}

async function freeName(dir, base, ext) {
  for (let n = 1; n < 1000; n++) {
    const name = `${base} (edited${n > 1 ? ` ${n}` : ''}).${ext}`
    try {
      await fsp.access(path.join(dir, name))
    } catch {
      return path.join(dir, name)
    }
  }
  throw new Error('No free file name')
}

class Editor {
  constructor({ thumbs, eraser }) {
    this.thumbs = thumbs
    this.eraser = eraser ?? null // Eraser (eraser.cjs), for the magic eraser
    this.cache = null // { id, mtime, source, small: { size, buf }, full: Promise<{ data, info }> }
  }

  /**
   * The cache entry of the item being edited (made when needed). Callers keep the object they get:
   * `this.cache` may already belong to another photo by the time an await returns.
   */
  async entry(item) {
    if (this.cache?.id === item.id && this.cache.mtime === item.mtime) return this.cache
    const source = await this.thumbs.source(item)
    if (!source) throw new Error("This photo can't be opened for editing")
    if (this.cache?.id === item.id && this.cache.mtime === item.mtime) return this.cache // made meanwhile
    const cache = { id: item.id, mtime: item.mtime, source, small: null, full: null }
    this.cache = cache
    return cache
  }

  /** The picture to edit (full size), cached for the item being edited. */
  async source(item) {
    return (await this.entry(item)).source
  }

  /** The photo upright at full size as raw pixels; kept once the magic eraser is used. */
  async full(item) {
    const cache = await this.entry(item)
    if (!cache.full) {
      cache.full = decode(cache.source)
      cache.full.catch(() => (cache.full = null))
    }
    return cache.full
  }

  /** Runs magic eraser steps on this photo (results are cached per photo and step). */
  eraseFor(item) {
    const eraser = this.eraser
    if (!eraser) return undefined
    return (img, steps) => eraser.apply(img, steps, `${item.id}:${item.mtime}`)
  }

  /**
   * The magic eraser: fills what `strokes` cover and resolves to the recipe step that does it
   * ({ step, ms, device, regions }). Strokes are on the picture as shown while editing (the recipe
   * without its crop): [{ size: brush diameter as a fraction of its long side, points: [x, y, …]
   * as fractions of its width and height }]. The fill is made at full size, so the preview and the
   * saved copy reuse it.
   */
  async erase(item, recipe, strokes) {
    if (!this.eraser) throw new Error("The magic eraser isn't available")
    const r = cleanRecipe(recipe)
    const full = await this.full(item)
    const { width: W0, height: H0 } = full.info
    const view = fromView(r, W0, H0)
    const step = makeStep(strokes, view.map, view.scale, W0, H0)
    if (!step) throw new Error('Paint over what you want to remove first')
    const started = performance.now()
    await this.eraser.apply(full, [...r.erase, step], `${item.id}:${item.mtime}`)
    const last = this.eraser.last
    return { step, ms: Math.round(performance.now() - started), device: last?.device ?? null, regions: last?.regions ?? 0 }
  }

  /** A preview of the recipe, about `size` px on its long side (JPEG). */
  async preview(item, recipe, size = 1600) {
    // this photo's own cache entry (another photo may be opened while this one is being prepared)
    const cache = await this.entry(item)
    // Previews start from a cached downscaled copy, so moving a slider stays quick.
    if (!cache.small || cache.small.size !== size) {
      const buf = await sharp(cache.source, { failOn: 'none' })
        .rotate()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .toBuffer()
      cache.small = { size, buf }
    }
    const out = await apply(cache.small.buf, recipe, undefined, this.eraseFor(item))
    const { data, info } = await out.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height }
  }

  /** Saves the edited copy next to the original. Resolves to its path. */
  async save(item, recipe) {
    const r = cleanRecipe(recipe)
    if (isIdentity(r)) throw new Error('Nothing to save — no changes yet')
    const source = await this.source(item)
    const format = OUTPUT[item.ext] && typeof source === 'string' ? OUTPUT[item.ext] : 'jpeg'
    // a transparent PNG / WebP / AVIF / TIFF stays transparent (JPG has no transparency)
    const alpha = ALPHA_FORMATS.has(format) && !!(await sharp(source, { failOn: 'none' }).metadata()).hasAlpha
    let out
    if (r.erase.length) {
      // the erased full-size picture is usually still cached from pressing "Erase"
      const erase = this.eraseFor(item)
      if (!erase) throw new Error("The magic eraser isn't available")
      let img = await erase(await this.full(item), r.erase)
      if (alpha) img = await withAlphaOf(source, img)
      out = await render(img, r)
    } else {
      out = await apply(source, r, undefined, undefined, { alpha })
    }
    const ext = format === 'jpeg' ? (OUTPUT[item.ext] === 'jpeg' ? item.ext : 'jpg') : item.ext
    const file = await freeName(item.dir, path.basename(item.name, path.extname(item.name)), ext)
    // The pixels were rebuilt, so write the facts that matter explicitly: capture date (the copy sits
    // next to the original in the timeline), camera and place.
    const ifd0 = { Software: 'Lumen' }
    if (item.meta?.make) ifd0.Make = item.meta.make
    if (item.meta?.model) ifd0.Model = item.meta.model
    const exif = { IFD0: ifd0, IFD2: { DateTimeOriginal: exifDate(item.date) } }
    if (Number.isFinite(item.meta?.lat) && Number.isFinite(item.meta?.lon)) exif.IFD3 = gpsTags(item.meta.lat, item.meta.lon)
    let pipeline = out.withExif(exif)
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true })
    else if (format === 'png') pipeline = pipeline.png()
    else if (format === 'webp') pipeline = pipeline.webp({ quality: 92 })
    else if (format === 'avif') pipeline = pipeline.avif({ quality: 70 })
    else pipeline = pipeline.tiff({ quality: 92 })
    await pipeline.toFile(file)
    return file
  }

  release() {
    this.cache = null
    this.eraser?.release()
  }
}

module.exports = { Editor, cleanRecipe, inscribed, fromView }
