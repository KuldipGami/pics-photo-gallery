const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')

/**
 * Photo edits, always saved as a new file next to the original (the original is never changed).
 *
 * An edit is a small recipe applied in this order:
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
  }
}

const isIdentity = (r) =>
  !r.quarter && !r.flip && !r.straighten && !r.crop && !r.enhance && !r.light && !r.contrast && !r.color && !r.warmth

/** Largest centred rectangle with the picture's proportions that fits after rotating by `deg`. */
function inscribed(w, h, deg) {
  const a = Math.abs(deg) * RAD
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const s = Math.min(w / (w * cos + h * sin), h / (w * sin + h * cos))
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)) }
}

/**
 * Runs the recipe. `input` is a file path or an image buffer; `maxSize` shrinks the picture first
 * (for previews). Resolves to a sharp pipeline ready for output.
 */
async function apply(input, recipe, maxSize) {
  const r = cleanRecipe(recipe)
  // 1. upright (EXIF orientation), optionally smaller, quarter turns
  let img = sharp(input, { failOn: 'none' }).rotate()
  if (maxSize) img = img.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
  let { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const raw = () => ({ raw: { width: info.width, height: info.height, channels: info.channels } })
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
  constructor({ thumbs }) {
    this.thumbs = thumbs
    this.cache = null // { id, mtime, source, preview: { data, info } }
  }

  /** The picture to edit (full size), cached for the item being edited. */
  async source(item) {
    if (this.cache?.id === item.id && this.cache.mtime === item.mtime) return this.cache.source
    const source = await this.thumbs.source(item)
    if (!source) throw new Error("This photo can't be opened for editing")
    this.cache = { id: item.id, mtime: item.mtime, source, small: null }
    return source
  }

  /** A preview of the recipe, about `size` px on its long side (JPEG). */
  async preview(item, recipe, size = 1600) {
    await this.source(item)
    // Previews start from a cached downscaled copy, so moving a slider stays quick.
    if (!this.cache.small || this.cache.small.size !== size) {
      const buf = await sharp(this.cache.source, { failOn: 'none' })
        .rotate()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .toBuffer()
      this.cache.small = { size, buf }
    }
    const out = await apply(this.cache.small.buf, recipe)
    const { data, info } = await out.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height }
  }

  /** Saves the edited copy next to the original. Resolves to its path. */
  async save(item, recipe) {
    const r = cleanRecipe(recipe)
    if (isIdentity(r)) throw new Error('Nothing to save — no changes yet')
    const source = await this.source(item)
    const out = await apply(source, r)
    const format = OUTPUT[item.ext] && typeof source === 'string' ? OUTPUT[item.ext] : 'jpeg'
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
  }
}

module.exports = { Editor, cleanRecipe, inscribed }
