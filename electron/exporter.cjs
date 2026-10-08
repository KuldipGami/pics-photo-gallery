const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const zlib = require('node:zlib')
const { uniquePath } = require('./cleanup.cjs')
const { bestDate, formatDate, exifFor } = require('./organize.cjs')

/**
 * Export & share: copies of photos and videos for sending (WhatsApp, email, a USB stick…), into a
 * folder or a single .zip file. Original files are never written to: every export reads them and
 * writes new files only.
 *
 *  - Photos keep their bytes when nothing has to change. Removing the location or all details from
 *    a JPEG, PNG or WebP at full size is done without re-compressing (only metadata bytes change).
 *    Resizing or converting re-encodes with sharp; HEIC / RAW / BMP go through Windows' own decoder
 *    (`getSource(item)`, i.e. thumbs.source) and come out as JPG.
 *  - Videos are never re-encoded. In MP4 / MOV / M4V / 3GP files the location (and, for "remove all
 *    details", dates, camera and other tags) is blanked in place inside the copy: boxes keep their
 *    size, so the video plays exactly as before. Other video types are copied as they are.
 *  - A .zip is written by a small streaming zip writer (stored entries: photos and videos are
 *    already compressed; Zip64 when the archive or a file passes 4 GB).
 */

// ── options ─────────────────────────────────────────────────────────────────

/** Long side in pixels (0 = original size). */
const SIZES = { original: 0, large: 2560, medium: 1600, small: 1080 }

const DEFAULTS = {
  size: 'original',
  format: 'keep', // 'keep' | 'jpg'
  quality: 85,
  removeLocation: false,
  removeMetadata: false,
  naming: 'keep', // 'keep' | 'date' | 'sequence'
  baseName: '',
  destination: 'folder', // 'folder' | 'zip'
}

/** Quick choices shown at the top of the export dialog (same values in ExportDialog.tsx). */
const PRESETS = {
  originals: { size: 'original', format: 'keep', removeLocation: false, removeMetadata: false },
  share: { size: 'medium', format: 'jpg', quality: 82, removeLocation: true, removeMetadata: false },
  small: { size: 'small', format: 'jpg', quality: 78, removeLocation: true, removeMetadata: false },
}

const SHARP_IN = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff'])
const JPEG_EXT = new Set(['jpg', 'jpeg', 'jfif', 'jpe'])
const BMFF_VIDEO = new Set(['mp4', 'm4v', 'mov', '3gp', '3g2'])
const MAX_NAME = 150

/** Validates options coming from the renderer. `folder` / `zipPath` must be absolute. */
function normalizeOptions(raw = {}) {
  const o = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    if (raw.size in SIZES) o.size = raw.size
    if (raw.format === 'keep' || raw.format === 'jpg') o.format = raw.format
    if (Number.isFinite(raw.quality)) o.quality = Math.round(Math.min(100, Math.max(40, raw.quality)))
    o.removeLocation = !!raw.removeLocation
    o.removeMetadata = !!raw.removeMetadata
    if (['keep', 'date', 'sequence'].includes(raw.naming)) o.naming = raw.naming
    if (typeof raw.baseName === 'string') o.baseName = raw.baseName.slice(0, 120)
    if (raw.destination === 'folder' || raw.destination === 'zip') o.destination = raw.destination
    if (typeof raw.folder === 'string' && path.isAbsolute(raw.folder)) o.folder = raw.folder
    if (typeof raw.zipPath === 'string' && path.isAbsolute(raw.zipPath)) o.zipPath = /\.zip$/i.test(raw.zipPath) ? raw.zipPath : `${raw.zipPath}.zip`
  }
  if (o.removeMetadata) o.removeLocation = true
  return o
}

// ── names ───────────────────────────────────────────────────────────────────

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** A name Windows accepts: no \ / : * ? " < > |, no trailing dots or spaces, not CON / NUL… */
function safeName(raw, fallback = 'Export') {
  let s = String(raw ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME).trim()
  if (!s) s = fallback
  if (RESERVED.test(s)) s = `_${s}`
  return s
}

/** The extension (no dot, lower case) an item gets in the export. */
function outputExt(item, o) {
  if (item.type === 'video') return item.ext
  const ext = item.ext
  if (o.format === 'jpg') return JPEG_EXT.has(ext) ? ext : 'jpg'
  if (SHARP_IN.has(ext)) return ext
  // HEIC, RAW, BMP, ICO: copied as they are when nothing changes, else made into a JPG.
  return o.size === 'original' && !o.removeLocation ? ext : 'jpg'
}

const dateOf = (item) => {
  try {
    return bestDate(item)
  } catch {
    return item.date ?? item.mtime
  }
}

/**
 * The order files are exported in (by date, oldest first, for numbered names; else as given) and
 * the name each one gets: [{ item, name }]. Names are unique (case-insensitive) within the export.
 */
function planNames(items, options, { label = '' } = {}) {
  const o = normalizeOptions(options)
  const list = o.naming === 'keep' ? [...items] : [...items].sort((a, b) => dateOf(a) - dateOf(b) || a.name.localeCompare(b.name))
  const width = Math.max(3, String(list.length).length)
  const base = safeName(o.baseName || label || 'Photo', 'Photo')
  const taken = new Set()
  return list.map((item, i) => {
    const ext = outputExt(item, o)
    let stem
    if (o.naming === 'date') stem = formatDate(dateOf(item), 'yyyy-MM-dd HH.mm.ss')
    else if (o.naming === 'sequence') stem = `${base} ${String(i + 1).padStart(width, '0')}`
    else stem = safeName(path.basename(item.name, path.extname(item.name)), 'Photo')
    let name = `${stem}.${ext}`
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n}).${ext}`
    taken.add(name.toLowerCase())
    return { item, name }
  })
}

/** "2026-10-07" (today) when there's no album / trip name. */
function defaultLabel(label) {
  const s = typeof label === 'string' ? label.trim() : ''
  return safeName(s || formatDate(Date.now(), 'yyyy-MM-dd'), 'Export')
}

/**
 * Where an export goes unless the user picks somewhere else:
 * <Pictures>\Pics exports\<label> (a new folder: " (2)" when that one already has files) and
 * <Pictures>\Pics exports\<label>.zip (" (2)" when taken).
 */
function defaultDestinations(picturesDir, label) {
  const root = path.join(picturesDir, 'Pics exports')
  const name = defaultLabel(label)
  let folder = path.join(root, name)
  for (let n = 2; nonEmptyDir(folder); n++) folder = path.join(root, `${name} (${n})`)
  return { root, folder, zip: uniquePath(path.join(root, `${name}.zip`)) }
}

function nonEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).length > 0
  } catch (err) {
    return err.code !== 'ENOENT' // a file with that name: don't use it
  }
}

// ── byte helpers ────────────────────────────────────────────────────────────

const rd16 = (b, o, le) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
const rd32 = (b, o, le) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
const wr16 = (b, o, v, le) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o))
const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4]

/**
 * Removes the GPS block from TIFF / EXIF data in place (the bytes between `start` and `end` of
 * `buf`): every GPS value is zeroed and the GPS directory is emptied. Nothing moves, so offsets
 * elsewhere in the file (thumbnails, maker notes, MPF images) stay valid. Returns true if it changed anything.
 */
function scrubTiffGps(buf, start, end = buf.length) {
  const t = buf.subarray(start, Math.min(end, buf.length))
  if (t.length < 8) return false
  const le = t[0] === 0x49 && t[1] === 0x49
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return false
  if (rd16(t, 2, le) !== 42) return false
  let changed = false
  const seen = new Set()
  for (let ifd = rd32(t, 4, le), guard = 0; ifd >= 8 && ifd + 2 <= t.length && guard < 4 && !seen.has(ifd); guard++) {
    seen.add(ifd)
    const n = rd16(t, ifd, le)
    if (ifd + 2 + n * 12 + 4 > t.length) break
    for (let i = 0; i < n; i++) {
      const at = ifd + 2 + i * 12
      if (rd16(t, at, le) !== 0x8825) continue
      const gps = rd32(t, at + 8, le)
      if (gps < 8 || gps + 2 > t.length) continue
      const count = rd16(t, gps, le)
      if (gps + 2 + count * 12 > t.length) continue
      for (let j = 0; j < count; j++) {
        const e = gps + 2 + j * 12
        const type = rd16(t, e + 2, le)
        const size = (TIFF_TYPE_SIZE[type] ?? 1) * rd32(t, e + 4, le)
        if (size > 4) {
          const off = rd32(t, e + 8, le)
          if (off >= 8 && off + size <= t.length) t.fill(0, off, off + size)
        }
      }
      t.fill(0, gps + 2, Math.min(t.length, gps + 2 + count * 12 + 4)) // entries + next pointer
      wr16(t, gps, 0, le)
      changed = true
    }
    ifd = rd32(t, ifd + 2 + n * 12, le)
  }
  return changed
}

/** Orientation (1–8) from TIFF / EXIF data, or 1. */
function tiffOrientation(buf, start, end = buf.length) {
  const t = buf.subarray(start, Math.min(end, buf.length))
  if (t.length < 8) return 1
  const le = t[0] === 0x49
  if (!le && t[0] !== 0x4d) return 1
  const ifd = rd32(t, 4, le)
  if (ifd < 8 || ifd + 2 > t.length) return 1
  const n = rd16(t, ifd, le)
  for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= t.length; i++) {
    const at = ifd + 2 + i * 12
    if (rd16(t, at, le) === 0x0112) {
      const v = rd16(t, at + 8, le)
      return v >= 1 && v <= 8 ? v : 1
    }
  }
  return 1
}

/** A minimal EXIF APP1 segment that only says which way up the picture is. */
function orientationSegment(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8)
  tiff.writeUInt16BE(0x0112, 10)
  tiff.writeUInt16BE(3, 12) // SHORT
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt16BE(orientation, 18)
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const head = Buffer.from([0xff, 0xe1, 0, 0])
  head.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([head, body])
}

// XMP / IPTC location fields (latin1 view keeps byte offsets 1:1).
const XMP_LOCATION = String.raw`(?:exif|exifEX|photoshop|Iptc4xmpCore|Iptc4xmpExt|drone-dji|Camera):(?:GPS[A-Za-z0-9]*|City|State|Country|CountryCode|CountryName|Location|LocationCreated|LocationShown|Sublocation|ProvinceState|WorldRegion|GpsLatitude|GpsLongitude|GpsAltitude|Latitude|Longitude|AbsoluteAltitude|RelativeAltitude)`
const XMP_ATTR = new RegExp(String.raw`\s${XMP_LOCATION}\s*=\s*("[^"]*"|'[^']*')`, 'g')
const XMP_ELEM = new RegExp(String.raw`<(${XMP_LOCATION})\b[^>]*?(?:/>|>[\s\S]*?</\1\s*>)`, 'g')

/** Blanks location fields of XMP text in place (same length: replaced by spaces). */
function blankXmpLocation(buf, start, end) {
  const text = buf.toString('latin1', start, end)
  const out = text.replace(XMP_ELEM, (m) => ' '.repeat(m.length)).replace(XMP_ATTR, (m) => ' '.repeat(m.length))
  if (out === text) return false
  buf.write(out, start, 'latin1')
  return true
}

// IPTC place datasets (record 2): content location code / name, city, sub-location, state, country code / name.
const IPTC_PLACE = new Set([26, 27, 90, 92, 95, 100, 101])

/** Blanks the place datasets of one IIM block (`start`…`end` of `buf`) in place, record by record. */
function blankIim(buf, start, end) {
  let changed = false
  for (let p = start; p < end; ) {
    if (buf[p] === 0) {
      p++ // padding
      continue
    }
    if (buf[p] !== 0x1c || p + 5 > end) break // not IIM (any more): leave the rest alone
    const record = buf[p + 1]
    const dataset = buf[p + 2]
    let len = buf.readUInt16BE(p + 3)
    let head = 5
    if (len & 0x8000) {
      // extended length: the next (len & 0x7fff) bytes hold it
      const n = len & 0x7fff
      if (n > 4 || p + 5 + n > end) break
      len = 0
      for (let i = 0; i < n; i++) len = len * 256 + buf[p + 5 + i]
      head += n
    }
    const data = p + head
    if (data + len > end) break
    if (record === 2 && IPTC_PLACE.has(dataset)) {
      buf.fill(0x20, data, data + len)
      changed = true
    }
    p = data + len
  }
  return changed
}

/**
 * Blanks IPTC place fields in a Photoshop APP13 body (`start`…`end` of `buf`), in place: walks
 * its image resources ("8BIM" blocks) to the IPTC one(s) and then the IIM records in them, so a
 * 0x1C byte elsewhere (a resource header, a thumbnail) is never taken for a record.
 */
function blankIptcLocation(buf, start, end) {
  const HEADER = 'Photoshop 3.0\0'
  if (end - start < HEADER.length || buf.toString('latin1', start, start + HEADER.length) !== HEADER) {
    // older layouts ("Adobe_Photoshop2.5:") hold the IIM records straight after their header
    const first = buf.indexOf(0x1c, start)
    return first >= 0 && first < end ? blankIim(buf, first, end) : false
  }
  let changed = false
  let p = start + HEADER.length
  while (p + 12 <= end) {
    const sig = buf.toString('latin1', p, p + 4)
    if (!/^(8BIM|MeSa|PHUT|AgHg|DCSR)$/.test(sig)) break
    const id = buf.readUInt16BE(p + 4)
    const nameSize = (1 + buf[p + 6] + 1) & ~1 // Pascal string, padded to an even length
    const sizeAt = p + 6 + nameSize
    if (sizeAt + 4 > end) break
    const size = buf.readUInt32BE(sizeAt)
    const data = sizeAt + 4
    if (data + size > end) break
    if (sig === '8BIM' && id === 0x0404 && blankIim(buf, data, data + size)) changed = true
    p = data + size + (size % 2)
  }
  return changed
}

// ── JPEG ────────────────────────────────────────────────────────────────────

/** Header segments up to the first scan: { segments: [{ pos, marker, len }], sos } or null. */
function jpegHeader(d) {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return null
  const segments = []
  let pos = 2
  while (pos + 3 < d.length) {
    if (d[pos] !== 0xff) return null
    const marker = d[pos + 1]
    if (marker === 0xff) {
      pos++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    if (marker === 0xda) return { segments, sos: pos }
    if (marker === 0xd8 || marker === 0xd9) return null
    const len = d.readUInt16BE(pos + 2)
    if (len < 2 || pos + 2 + len > d.length) return null
    segments.push({ pos, marker, len })
    pos += 2 + len
  }
  return null
}

/** Index just past the main image's EOI (data after it: MPF images, phone trailers…). */
function jpegEnd(d, sos) {
  let pos = sos
  while (pos + 1 < d.length) {
    if (d[pos] !== 0xff) return d.length
    const marker = d[pos + 1]
    if (marker === 0xd9) return pos + 2
    if (marker === 0xff) {
      pos++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    if (pos + 4 > d.length) return d.length
    const next = pos + 2 + d.readUInt16BE(pos + 2)
    if (marker !== 0xda) {
      pos = next
      continue
    }
    // entropy-coded data: runs until a 0xFF that isn't stuffing (FF00), a restart marker or fill
    let p = next
    for (;;) {
      p = d.indexOf(0xff, p)
      if (p < 0 || p + 1 >= d.length) return d.length
      const n = d[p + 1]
      if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) p += 2
      else if (n === 0xff) p += 1
      else break
    }
    pos = p
  }
  return d.length
}

const segText = (d, s, n) => d.toString('latin1', s.pos + 4, Math.min(s.pos + 4 + n, s.pos + 2 + s.len))
const isExifSeg = (d, s) => s.marker === 0xe1 && s.len >= 8 && segText(d, s, 6) === 'Exif\0\0'
const isXmpSeg = (d, s) => s.marker === 0xe1 && segText(d, s, 29) === 'http://ns.adobe.com/xap/1.0/\0'
const isXmpExtSeg = (d, s) => s.marker === 0xe1 && segText(d, s, 35) === 'http://ns.adobe.com/xmp/extension/\0'
const isIccSeg = (d, s) => s.marker === 0xe2 && segText(d, s, 12) === 'ICC_PROFILE\0'
const isAdobeSeg = (d, s) => s.marker === 0xee && segText(d, s, 5) === 'Adobe'

/** Finds "Exif\0\0" + TIFF blocks and XMP packets anywhere in `d` from `from` on and blanks their location. */
function scrubTrailing(d, from) {
  let changed = false
  const exif = Buffer.from('Exif\0\0', 'latin1')
  for (let p = d.indexOf(exif, from); p >= 0; p = d.indexOf(exif, p + 6)) {
    let end = d.length
    if (p >= 4 && d[p - 4] === 0xff && d[p - 3] === 0xe1) end = Math.min(d.length, p - 2 + d.readUInt16BE(p - 2))
    if (scrubTiffGps(d, p + 6, end)) changed = true
  }
  const open = Buffer.from('<x:xmpmeta', 'latin1')
  const close = Buffer.from('</x:xmpmeta>', 'latin1')
  for (let p = d.indexOf(open, from); p >= 0; p = d.indexOf(open, p + 10)) {
    const e = d.indexOf(close, p)
    if (e < 0) break
    if (blankXmpLocation(d, p, e + close.length)) changed = true
  }
  return changed
}

/**
 * Metadata changes to a JPEG without re-compressing it.
 *  - location: a copy with GPS, XMP location and IPTC place fields blanked in place (same size,
 *    so everything else — including extra images after the main one — stays intact).
 *  - all: a copy with only what's needed to show the picture right: JFIF, colour profile, Adobe
 *    colour info and (when the photo is turned) a tiny EXIF with just the orientation. Extra data
 *    after the image (phone trailers, MPF depth / HDR images, which carry their own metadata) is dropped.
 * Returns the new bytes, or null when the file isn't a JPEG this can read (the caller re-encodes then).
 */
function scrubJpeg(src, { location = false, all = false } = {}) {
  const head = jpegHeader(src)
  if (!head) return null
  if (all) {
    let orientation = 1
    const keep = []
    for (const s of head.segments) {
      if (orientation === 1 && isExifSeg(src, s)) orientation = tiffOrientation(src, s.pos + 10, s.pos + 2 + s.len)
      const app = s.marker >= 0xe0 && s.marker <= 0xef
      const ok = !app ? s.marker !== 0xfe : s.marker === 0xe0 || isIccSeg(src, s) || isAdobeSeg(src, s)
      if (ok) keep.push(s)
    }
    const parts = [src.subarray(0, 2)]
    let inserted = orientation === 1
    for (const s of keep) {
      if (!inserted && s.marker !== 0xe0) {
        parts.push(orientationSegment(orientation))
        inserted = true
      }
      parts.push(src.subarray(s.pos, s.pos + 2 + s.len))
    }
    if (!inserted) parts.push(orientationSegment(orientation))
    parts.push(src.subarray(head.sos, jpegEnd(src, head.sos)))
    return Buffer.concat(parts)
  }
  const d = Buffer.from(src)
  if (!location) return d
  for (const s of head.segments) {
    const start = s.pos + 4
    const end = s.pos + 2 + s.len
    if (isExifSeg(d, s)) scrubTiffGps(d, s.pos + 10, end)
    else if (isXmpSeg(d, s) || isXmpExtSeg(d, s)) blankXmpLocation(d, start, end)
    else if (s.marker === 0xed) blankIptcLocation(d, start, end)
  }
  scrubTrailing(d, jpegEnd(d, head.sos))
  return d
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// Ancillary chunks that affect how the picture looks (kept by "remove all details").
const PNG_VISUAL = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLi'])

function pngChunks(d) {
  if (d.length < 8 || !d.subarray(0, 8).equals(PNG_SIG)) return null
  const chunks = []
  for (let p = 8; p + 12 <= d.length; ) {
    const len = d.readUInt32BE(p)
    const type = d.toString('latin1', p + 4, p + 8)
    if (p + 12 + len > d.length) return null
    chunks.push({ pos: p, len, type })
    p += 12 + len
    if (type === 'IEND') break
  }
  return chunks
}

function fixPngCrc(d, c) {
  d.writeUInt32BE(zlib.crc32(d.subarray(c.pos + 4, c.pos + 8 + c.len)) >>> 0, c.pos + 8 + c.len)
}

/** PNG metadata changes without re-compressing (see scrubJpeg). Null when it isn't a readable PNG. */
function scrubPng(src, { location = false, all = false } = {}) {
  const chunks = pngChunks(src)
  if (!chunks) return null
  if (all) {
    const parts = [PNG_SIG]
    for (const c of chunks) {
      const critical = c.type[0] === c.type[0].toUpperCase()
      if (critical || PNG_VISUAL.has(c.type)) parts.push(src.subarray(c.pos, c.pos + 12 + c.len))
    }
    return Buffer.concat(parts)
  }
  const d = Buffer.from(src)
  if (!location) return d
  const drop = new Set()
  for (const c of chunks) {
    const data = c.pos + 8
    if (c.type === 'eXIf') {
      const tiff = d.toString('latin1', data, data + 6) === 'Exif\0\0' ? data + 6 : data
      if (scrubTiffGps(d, tiff, data + c.len)) fixPngCrc(d, c)
    } else if (c.type === 'iTXt' && d.toString('latin1', data, data + 18) === 'XML:com.adobe.xmp\0') {
      if (d[data + 18] !== 0) drop.add(c) // compressed XMP: can't blank in place
      else if (blankXmpLocation(d, data + 18, data + c.len)) fixPngCrc(d, c)
    } else if ((c.type === 'tEXt' || c.type === 'zTXt') && /^(Raw profile type (exif|xmp|iptc|APP1))\0/i.test(d.toString('latin1', data, data + 40))) {
      drop.add(c) // ImageMagick-style hex-encoded metadata
    }
  }
  if (!drop.size) return d
  return Buffer.concat([PNG_SIG, ...chunks.filter((c) => !drop.has(c)).map((c) => d.subarray(c.pos, c.pos + 12 + c.len))])
}

// ── WebP ────────────────────────────────────────────────────────────────────

function webpChunks(d) {
  if (d.length < 12 || d.toString('latin1', 0, 4) !== 'RIFF' || d.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunks = []
  for (let p = 12; p + 8 <= d.length; ) {
    const type = d.toString('latin1', p, p + 4)
    const len = d.readUInt32LE(p + 4)
    if (p + 8 + len > d.length) return null
    chunks.push({ pos: p, len, type, size: 8 + len + (len & 1) })
    p += 8 + len + (len & 1)
  }
  return chunks
}

/** WebP metadata changes without re-compressing (see scrubJpeg). Null when it isn't a readable WebP. */
function scrubWebp(src, { location = false, all = false } = {}) {
  const chunks = webpChunks(src)
  if (!chunks) return null
  if (all) {
    const kept = chunks.filter((c) => c.type !== 'EXIF' && c.type !== 'XMP ')
    const body = Buffer.concat(kept.map((c) => Buffer.from(src.subarray(c.pos, Math.min(src.length, c.pos + c.size)))))
    const vp8x = body.indexOf('VP8X', 0, 'latin1')
    if (vp8x === 0) body[8] &= ~0x0c // no EXIF / XMP flags
    const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1')
    head.writeUInt32LE(4 + body.length, 4)
    return Buffer.concat([head, body])
  }
  const d = Buffer.from(src)
  if (!location) return d
  for (const c of chunks) {
    const data = c.pos + 8
    if (c.type === 'EXIF') scrubTiffGps(d, d.toString('latin1', data, data + 6) === 'Exif\0\0' ? data + 6 : data, data + c.len)
    else if (c.type === 'XMP ') blankXmpLocation(d, data, data + c.len)
  }
  return d
}

/** Lossless metadata change for a whole file's bytes by type. Null = can't (re-encode instead). */
function scrubImage(data, ext, how) {
  if (JPEG_EXT.has(ext)) return scrubJpeg(data, how)
  if (ext === 'png') return scrubPng(data, how)
  if (ext === 'webp') return scrubWebp(data, how)
  if ((ext === 'tif' || ext === 'tiff') && how.location && !how.all) {
    const d = Buffer.from(data)
    scrubTiffGps(d, 0)
    scrubTrailing(d, 8)
    return d
  }
  if (ext === 'gif') return data // GIF has no EXIF; nothing to remove
  return null
}

// ── videos (ISO base media: MP4 / MOV / M4V / 3GP) ─────────────────────────

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'udta', 'edts', 'meta', 'ilst'])
const LOCATION_ATOMS = new Set(['©xyz', 'loci', 'gps ', '©gps'])
const XMP_UUID = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex')
const isLocationKey = (k) => /location|gps|©xyz/i.test(k)

/** Reads one box header at `pos` of an open file: { type, start, size, header } or null. */
async function boxAt(fh, pos, fileSize) {
  if (pos + 8 > fileSize) return null
  const b = Buffer.alloc(16)
  await fh.read(b, 0, 16, pos)
  let size = b.readUInt32BE(0)
  const type = b.toString('latin1', 4, 8)
  let header = 8
  if (size === 1) {
    size = Number(b.readBigUInt64BE(8))
    header = 16
  } else if (size === 0) size = fileSize - pos
  if (size < header || pos + size > fileSize) return null
  return { type, start: pos, size, header }
}

/** Child boxes of a box held in memory: [{ type, pos, size, header }] (positions within `d`). */
function childBoxes(d, from, to) {
  const out = []
  for (let p = from; p + 8 <= to; ) {
    let size = d.readUInt32BE(p)
    let header = 8
    if (size === 1 && p + 16 <= to) {
      size = Number(d.readBigUInt64BE(p + 8))
      header = 16
    } else if (size === 0) size = to - p
    if (size < header || p + size > to) break
    out.push({ type: d.toString('latin1', p + 4, p + 8), pos: p, size, header })
    p += size
  }
  return out
}

/** 'meta' is a full box in MP4 (4 bytes of version / flags) but a plain atom in QuickTime. */
const metaChildrenStart = (d, b) => {
  const at = b.pos + b.header
  return d.toString('latin1', at + 4, at + 8) === 'hdlr' ? at : at + 4
}

/** Turns a box into a 'free' box of the same size with zeroed content (players skip it). */
function freeBox(d, b) {
  d.write('free', b.pos + 4, 'latin1')
  d.fill(0, b.pos + b.header, b.pos + b.size)
}

/**
 * Blanks metadata in a movie box held in memory (`d` = the whole moov box). location: GPS atoms
 * (©xyz, loci), QuickTime location keys, XMP location. all: also every user-data / metadata atom
 * and the creation / modification times in the movie, track and media headers.
 * Returns how many things were blanked.
 */
function scrubMoov(d, { all = false } = {}) {
  let changed = 0
  const walk = (from, to, parent) => {
    const kids = childBoxes(d, from, to)
    let keys = null
    for (const b of kids) {
      const body = b.pos + b.header
      const end = b.pos + b.size
      if (b.type === 'keys') keys = readKeys(d, body, end)
      if (all && ['mvhd', 'tkhd', 'mdhd'].includes(b.type)) {
        const version = d[body]
        const n = version === 1 ? 8 : 4
        d.fill(0, body + 4, Math.min(end, body + 4 + 2 * n)) // creation + modification time
        changed++
        continue
      }
      if (parent === 'udta' && (all || LOCATION_ATOMS.has(b.type))) {
        freeBox(d, b)
        changed++
        continue
      }
      if (b.type === 'uuid' && b.size >= b.header + 16 && d.subarray(body, body + 16).equals(XMP_UUID)) {
        if (all) freeBox(d, b)
        else blankXmpLocation(d, body + 16, end)
        changed++
        continue
      }
      if (b.type === 'XMP_') {
        if (all) freeBox(d, b)
        else blankXmpLocation(d, body, end)
        changed++
        continue
      }
      if (b.type === 'meta' && parent === 'moov' && all) {
        freeBox(d, b)
        changed++
        continue
      }
      if (CONTAINERS.has(b.type) && b.type !== 'ilst') walk(b.type === 'meta' ? metaChildrenStart(d, b) : body, end, b.type)
      if (b.type === 'ilst') changed += scrubIlst(d, b, keys, all)
    }
  }
  const top = childBoxes(d, 0, d.length)[0]
  if (top?.type === 'moov') walk(top.pos + top.header, top.pos + top.size, 'moov')
  return changed
}

/** QuickTime metadata keys: index (1-based) → { name, pos, len }. */
function readKeys(d, body, end) {
  const keys = new Map()
  if (body + 8 > end) return keys
  const count = d.readUInt32BE(body + 4)
  let p = body + 8
  for (let i = 1; i <= count && p + 8 <= end; i++) {
    const size = d.readUInt32BE(p)
    if (size < 8 || p + size > end) break
    keys.set(i, { name: d.toString('latin1', p + 8, p + size), pos: p + 8, len: size - 8 })
    p += size
  }
  return keys
}

/** Blanks location items (or all items) in an 'ilst': their values are zeroed and their key renamed. */
function scrubIlst(d, ilst, keys, all) {
  let changed = 0
  for (const item of childBoxes(d, ilst.pos + ilst.header, ilst.pos + ilst.size)) {
    const index = d.readUInt32BE(item.pos + 4)
    const key = keys?.get(index)
    const name = key ? key.name : item.type
    if (!all && !isLocationKey(name) && !LOCATION_ATOMS.has(item.type)) continue
    for (const data of childBoxes(d, item.pos + item.header, item.pos + item.size)) {
      if (data.type === 'data') d.fill(0, Math.min(data.pos + data.size, data.pos + data.header + 8), data.pos + data.size)
      else d.fill(0, data.pos + data.header, data.pos + data.size)
    }
    if (key) d.write('lumen.removed'.padEnd(key.len, '.').slice(0, key.len), key.pos, 'latin1')
    changed++
  }
  return changed
}

/** The first child box of `b` (a box in `d`) of this type, or undefined. */
const childOf = (d, b, type, from = b.pos + b.header) => childBoxes(d, from, b.pos + b.size).find((c) => c.type === type)

/**
 * Tracks of a movie box (`d` = the whole moov box) whose samples can hold a position: timed
 * metadata (GoPro 'gpmd', Google / Insta360 'camm', DJI, Sony and other 'meta' tracks; Apple's
 * 'mebx' only when it lists location keys) and subtitle / text tracks (DJI drones write their
 * GPS there). Their data lives among the video's samples, so it can't be blanked like the header
 * atoms; such a video is reported as keeping details. Returns how many there are.
 */
function locationTracks(d) {
  const top = childBoxes(d, 0, d.length)[0]
  if (top?.type !== 'moov') return 0
  let n = 0
  for (const trak of childBoxes(d, top.pos + top.header, top.pos + top.size)) {
    if (trak.type !== 'trak') continue
    const mdia = childOf(d, trak, 'mdia')
    const hdlr = mdia && childOf(d, mdia, 'hdlr')
    if (!hdlr || hdlr.size < hdlr.header + 12) continue
    const handler = d.toString('latin1', hdlr.pos + hdlr.header + 8, hdlr.pos + hdlr.header + 12)
    const minf = childOf(d, mdia, 'minf')
    const stbl = minf && childOf(d, minf, 'stbl')
    const stsd = stbl && childOf(d, stbl, 'stsd')
    const format = stsd && stsd.size >= stsd.header + 16 ? d.toString('latin1', stsd.pos + stsd.header + 12, stsd.pos + stsd.header + 16) : ''
    const described = stsd ? d.toString('latin1', stsd.pos, stsd.pos + stsd.size) : ''
    if (handler === 'meta' || handler === 'camm') {
      if (format !== 'mebx' || /location|gps|iso6709/i.test(described)) n++
    } else if (handler === 'sbtl' || handler === 'subt' || handler === 'text') n++
  }
  return n
}

/**
 * Byte patches that blank a video's metadata in a copy (the original is only read):
 * [{ offset, data }] (same length as what they replace), or [] when there's nothing to change or
 * the file isn't an MP4 / MOV. `all`: also dates, camera and every other tag.
 */
async function videoPatches(file, { all = false } = {}) {
  return (await videoScan(file, { all })).patches
}

/**
 * videoPatches plus what can't be removed: { patches, tracks (see locationTracks), unread (the
 * movie box couldn't be read, so nothing in it was blanked) }.
 */
async function videoScan(file, { all = false } = {}) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size: fileSize } = await fh.stat()
    const patches = []
    let tracks = 0
    let unread = true
    for (let pos = 0, guard = 0; pos < fileSize && guard < 64; guard++) {
      const box = await boxAt(fh, pos, fileSize)
      if (!box) break
      if (box.type === 'moov' && box.size <= 512 * 1024 * 1024) {
        const d = Buffer.alloc(box.size)
        await fh.read(d, 0, box.size, box.start)
        unread = false
        tracks += locationTracks(d)
        if (scrubMoov(d, { all })) patches.push({ offset: box.start, data: d })
      } else if (box.type === 'uuid' && box.size <= 16 * 1024 * 1024) {
        const d = Buffer.alloc(box.size)
        await fh.read(d, 0, box.size, box.start)
        if (d.subarray(box.header, box.header + 16).equals(XMP_UUID)) {
          if (all) freeBox(d, { pos: 0, size: box.size, header: box.header })
          else blankXmpLocation(d, box.header + 16, d.length)
          patches.push({ offset: box.start, data: d })
        }
      } else if (box.type === 'meta' && all && box.size <= 16 * 1024 * 1024) {
        // a top-level metadata box: becomes a zeroed 'free' box of the same size
        const d = Buffer.alloc(box.size)
        await fh.read(d, 0, box.header, box.start) // keeps the size field
        freeBox(d, { pos: 0, size: box.size, header: box.header })
        patches.push({ offset: box.start, data: d })
      }
      pos = box.start + box.size
    }
    return { patches, tracks, unread }
  } finally {
    await fh.close()
  }
}

/** Applies patches to a chunk that starts at file offset `at` (in place). */
function patchChunk(chunk, at, patches) {
  const end = at + chunk.length
  for (const p of patches) {
    const pEnd = p.offset + p.data.length
    if (pEnd <= at || p.offset >= end) continue
    const from = Math.max(at, p.offset)
    const to = Math.min(end, pEnd)
    p.data.copy(chunk, from - at, from - p.offset, to - p.offset)
  }
  return chunk
}

// ── preparing one file ──────────────────────────────────────────────────────

const abortError = () => Object.assign(new Error('Export cancelled'), { name: 'AbortError' })

/** EXIF for a photo decoded by Windows (it has none of its own), from the library item. */
function exifFromItem(item, { location }) {
  try {
    const exif = exifFor(item)
    if (!location) delete exif.IFD3
    return exif
  } catch {
    return {}
  }
}

/**
 * What to write for one item: { kind: 'buffer', data } or { kind: 'file', path, size, patches },
 * plus { mtime, converted?, keptVideoDetails? }. Throws with a plain-language message on failure.
 */
async function prepare(item, name, o, getSource) {
  const keepDates = !o.removeMetadata
  const mtime = keepDates ? item.mtime : Date.now()
  const how = { location: o.removeLocation, all: o.removeMetadata }
  const changing = how.location || how.all

  if (item.type === 'video') {
    const st = await fsp.stat(item.path)
    let patches = []
    let kept = false
    let keptTrack = false
    if (changing) {
      if (BMFF_VIDEO.has(item.ext)) {
        // never claim details were removed when they weren't: an unreadable movie box, or a GPS
        // track among the samples (GoPro, DJI…), counts as kept
        const scan = await videoScan(item.path, { all: how.all }).catch(() => ({ patches: [], tracks: 0, unread: true }))
        patches = scan.patches
        keptTrack = scan.tracks > 0
        kept = scan.unread || keptTrack
      } else kept = true
    }
    return { kind: 'file', path: item.path, size: st.size, patches, mtime, keptVideoDetails: kept, keptVideoTrack: keptTrack }
  }

  const ext = item.ext
  const outExt = path.extname(name).slice(1).toLowerCase()
  const long = SIZES[o.size]
  const sharp = require('sharp')

  if (SHARP_IN.has(ext)) {
    const meta = await sharp(item.path, { failOn: 'none' }).metadata()
    const side = Math.max(meta.width || 0, meta.height || 0)
    const resize = long > 0 && side > long
    const sameFormat = outExt === ext || (JPEG_EXT.has(outExt) && JPEG_EXT.has(ext))
    if (!resize && sameFormat) {
      if (!changing) {
        const st = await fsp.stat(item.path)
        return { kind: 'file', path: item.path, size: st.size, patches: [], mtime }
      }
      const data = scrubImage(await fsp.readFile(item.path), ext, how)
      if (data) return { kind: 'buffer', data, mtime }
    }
    const animated = ext === 'gif' && outExt === 'gif' && (meta.pages || 1) > 1
    let img = sharp(item.path, { failOn: 'none', animated }).rotate()
    if (resize) img = img.resize(long, long, { fit: 'inside', withoutEnlargement: true })
    if (JPEG_EXT.has(outExt) && meta.hasAlpha) img = img.flatten({ background: '#ffffff' })
    const scrubAfter = how.location && !how.all && ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'tif', 'tiff'].includes(outExt)
    if (how.all) img = img.keepIccProfile()
    else if (scrubAfter || !how.location) img = img.keepMetadata()
    else img = img.keepIccProfile().withExif(exifFromItem(item, { location: false }))
    img = encode(img, outExt, o.quality)
    let data = await img.toBuffer()
    if (scrubAfter) data = scrubImage(data, outExt, { location: true }) ?? data
    return { kind: 'buffer', data, mtime, converted: !sameFormat }
  }

  // HEIC / HEIF / RAW / BMP / ICO
  if (outExt === ext) {
    const st = await fsp.stat(item.path)
    return { kind: 'file', path: item.path, size: st.size, patches: [], mtime }
  }
  const source = getSource ? await getSource(item) : null
  if (!source) throw new Error(ext === 'heic' || ext === 'heif' ? "Windows can't open this HEIC photo (the free HEIF Image Extensions from Microsoft Store are needed)" : "Windows can't open this photo")
  let img = sharp(source, { failOn: 'none' }).rotate()
  if (long > 0) img = img.resize(long, long, { fit: 'inside', withoutEnlargement: true })
  img = img.flatten({ background: '#ffffff' })
  if (how.all) img = img.keepIccProfile()
  else img = img.keepIccProfile().withExif(exifFromItem(item, { location: !how.location }))
  const data = await encode(img, 'jpg', o.quality).toBuffer()
  return { kind: 'buffer', data, mtime, converted: true }
}

function encode(img, ext, quality) {
  if (JPEG_EXT.has(ext)) return img.jpeg({ quality, mozjpeg: false })
  if (ext === 'png') return img.png({ compressionLevel: 9, effort: 4 })
  if (ext === 'webp') return img.webp({ quality })
  if (ext === 'avif') return img.avif({ quality: Math.max(40, quality - 20) })
  if (ext === 'gif') return img.gif()
  if (ext === 'tif' || ext === 'tiff') return img.tiff({ compression: 'lzw' })
  return img.jpeg({ quality })
}

// ── writing: folder ─────────────────────────────────────────────────────────

const CHUNK = 1024 * 1024

/** Marks an error as coming from reading the photo being exported (not from the destination). */
const sourceError = (err) => Object.assign(err instanceof Error ? err : new Error(String(err)), { readingSource: true })

/**
 * Streams `file` (with patches applied) to `write(chunk)`; checks `signal` between chunks. Errors
 * reading `file` are marked `readingSource` (that file fails, the export goes on).
 */
async function streamFile(file, patches, signal, write) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
  } catch (err) {
    throw sourceError(err)
  }
  try {
    let at = 0
    const buf = Buffer.allocUnsafe(CHUNK)
    for (;;) {
      if (signal?.aborted) throw abortError()
      let bytesRead
      try {
        ;({ bytesRead } = await fh.read(buf, 0, CHUNK, at))
      } catch (err) {
        throw sourceError(err)
      }
      if (!bytesRead) break
      const chunk = Buffer.from(buf.subarray(0, bytesRead))
      if (patches.length) patchChunk(chunk, at, patches)
      await write(chunk)
      at += bytesRead
    }
    return at
  } finally {
    await fh.close().catch(() => {})
  }
}

class FolderWriter {
  constructor(dir) {
    this.dir = dir
    this.written = [] // final paths
    this.claimed = new Set()
    this.createdDir = false
  }

  async open() {
    try {
      await fsp.access(this.dir)
    } catch {
      this.createdDir = true
    }
    await fsp.mkdir(this.dir, { recursive: true })
  }

  /** Never overwrites: "name (2).jpg" when the name is taken. */
  claim(name) {
    let target = uniquePath(path.join(this.dir, name))
    if (this.claimed.has(target.toLowerCase())) {
      const ext = path.extname(name)
      const stem = path.basename(name, ext)
      for (let n = 2; this.claimed.has(target.toLowerCase()) || fs.existsSync(target); n++) target = path.join(this.dir, `${stem} (${n})${ext}`)
    }
    this.claimed.add(target.toLowerCase())
    return target
  }

  async add(name, prepared, { signal, onBytes }) {
    const target = this.claim(name)
    const temp = `${target}.lumen-export`
    try {
      if (prepared.kind === 'buffer') {
        await fsp.writeFile(temp, prepared.data, { flag: 'wx' })
        onBytes?.(prepared.data.length)
      } else {
        const out = await fsp.open(temp, 'wx')
        try {
          await streamFile(prepared.path, prepared.patches, signal, async (chunk) => {
            await out.write(chunk)
            onBytes?.(chunk.length)
          })
        } finally {
          await out.close()
        }
      }
      await fsp.rename(temp, target)
      const when = new Date(prepared.mtime)
      await fsp.utimes(target, when, when).catch(() => {})
      this.written.push(target)
      return target
    } catch (err) {
      await fsp.rm(temp, { force: true }).catch(() => {})
      throw err
    }
  }

  /** Cancelled: keep what's finished; remove the folder only if it was made for this export and is empty. */
  async abort() {
    if (this.createdDir && !this.written.length) await fsp.rmdir(this.dir).catch(() => {})
  }

  async close() {
    return this.dir
  }
}

// ── writing: zip ────────────────────────────────────────────────────────────

const U32 = 0xffffffff

function dosDateTime(ms) {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime()) || d.getFullYear() < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 }
  const year = Math.min(2107, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * A minimal streaming zip writer (stored entries, UTF-8 names, extended timestamps, Zip64 when
 * needed). Sizes are known before each entry is written (buffers, or files whose size we stat),
 * so no data descriptors are needed; the CRC is patched into the local header after streaming.
 * Writes to "<file>.partial" and renames when done.
 */
class ZipWriter {
  constructor(file, { forceZip64 = false } = {}) {
    this.file = file
    this.temp = `${file}.partial`
    this.forceZip64 = forceZip64
    this.entries = []
    this.pos = 0
    this.fh = null
    this.names = new Set()
  }

  async open() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true })
    this.fh = await fsp.open(this.temp, 'w')
  }

  async write(buf) {
    let off = 0
    while (off < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, this.pos)
      off += bytesWritten
      this.pos += bytesWritten
    }
  }

  uniqueName(name) {
    let n = name
    const ext = path.extname(name)
    const stem = path.basename(name, ext)
    for (let i = 2; this.names.has(n.toLowerCase()); i++) n = `${stem} (${i})${ext}`
    this.names.add(n.toLowerCase())
    return n
  }

  async add(name, prepared, { signal, onBytes }) {
    const entryName = this.uniqueName(name)
    const offset = this.pos
    try {
      await this.writeEntry(entryName, prepared, { signal, onBytes })
      return entryName
    } catch (err) {
      // This entry failed: what was written of it is cut off, so the next one starts at its place
      // (no stray local header or half a file is left in the zip).
      this.pos = offset
      this.names.delete(entryName.toLowerCase())
      await this.fh?.truncate(offset).catch(() => {})
      throw err
    }
  }

  async writeEntry(entryName, prepared, { signal, onBytes }) {
    const nameBytes = Buffer.from(entryName, 'utf8')
    const size = prepared.kind === 'buffer' ? prepared.data.length : prepared.size
    const zip64 = this.forceZip64 || size >= U32
    const { time, date } = dosDateTime(prepared.mtime)
    const unix = Math.max(0, Math.min(0x7fffffff, Math.floor(prepared.mtime / 1000)))
    const offset = this.pos

    const extras = []
    if (zip64) {
      const x = Buffer.alloc(20)
      x.writeUInt16LE(0x0001, 0)
      x.writeUInt16LE(16, 2)
      x.writeBigUInt64LE(BigInt(size), 4) // uncompressed
      x.writeBigUInt64LE(BigInt(size), 12) // compressed (stored)
      extras.push(x)
    }
    const ts = Buffer.alloc(9)
    ts.writeUInt16LE(0x5455, 0)
    ts.writeUInt16LE(5, 2)
    ts.writeUInt8(1, 4)
    ts.writeUInt32LE(unix, 5)
    extras.push(ts)
    const extra = Buffer.concat(extras)

    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(zip64 ? 45 : 20, 4)
    h.writeUInt16LE(0x0800, 6) // UTF-8 names
    h.writeUInt16LE(0, 8) // stored
    h.writeUInt16LE(time, 10)
    h.writeUInt16LE(date, 12)
    h.writeUInt32LE(0, 14) // CRC: patched below
    h.writeUInt32LE(zip64 ? U32 : size, 18)
    h.writeUInt32LE(zip64 ? U32 : size, 22)
    h.writeUInt16LE(nameBytes.length, 26)
    h.writeUInt16LE(extra.length, 28)
    await this.write(Buffer.concat([h, nameBytes, extra]))

    let crc = 0
    let written = 0
    if (prepared.kind === 'buffer') {
      crc = zlib.crc32(prepared.data)
      await this.write(prepared.data)
      written = prepared.data.length
      onBytes?.(written)
    } else {
      written = await streamFile(prepared.path, prepared.patches, signal, async (chunk) => {
        crc = zlib.crc32(chunk, crc)
        await this.write(chunk)
        onBytes?.(chunk.length)
      })
    }
    if (written !== size) throw new Error('The file changed while it was being exported')
    const c = Buffer.alloc(4)
    c.writeUInt32LE(crc >>> 0, 0)
    await this.fh.write(c, 0, 4, offset + 14)
    this.entries.push({ nameBytes, size, crc: crc >>> 0, time, date, unix, offset, zip64 })
  }

  async close() {
    const cdStart = this.pos
    for (const e of this.entries) {
      const big = this.forceZip64 || e.size >= U32 || e.offset >= U32
      const x64 = []
      if (big) {
        const fields = [BigInt(e.size), BigInt(e.size), BigInt(e.offset)]
        const x = Buffer.alloc(4 + fields.length * 8)
        x.writeUInt16LE(0x0001, 0)
        x.writeUInt16LE(fields.length * 8, 2)
        fields.forEach((v, i) => x.writeBigUInt64LE(v, 4 + i * 8))
        x64.push(x)
      }
      const ts = Buffer.alloc(9)
      ts.writeUInt16LE(0x5455, 0)
      ts.writeUInt16LE(5, 2)
      ts.writeUInt8(1, 4)
      ts.writeUInt32LE(e.unix, 5)
      const extra = Buffer.concat([...x64, ts])
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      h.writeUInt16LE(big || e.zip64 ? 45 : 20, 4) // made by: MS-DOS / NTFS attributes
      h.writeUInt16LE(big || e.zip64 ? 45 : 20, 6)
      h.writeUInt16LE(0x0800, 8)
      h.writeUInt16LE(0, 10)
      h.writeUInt16LE(e.time, 12)
      h.writeUInt16LE(e.date, 14)
      h.writeUInt32LE(e.crc, 16)
      h.writeUInt32LE(big ? U32 : e.size, 20)
      h.writeUInt32LE(big ? U32 : e.size, 24)
      h.writeUInt16LE(e.nameBytes.length, 28)
      h.writeUInt16LE(extra.length, 30)
      h.writeUInt16LE(0, 32) // comment
      h.writeUInt16LE(0, 34) // disk
      h.writeUInt16LE(0, 36) // internal attributes
      h.writeUInt32LE(0x20, 38) // archive
      h.writeUInt32LE(big ? U32 : e.offset, 42)
      await this.write(Buffer.concat([h, e.nameBytes, extra]))
    }
    const cdSize = this.pos - cdStart
    const count = this.entries.length
    const zip64 = this.forceZip64 || count >= 0xffff || cdStart >= U32 || cdSize >= U32 || this.entries.some((e) => e.zip64 || e.offset >= U32)
    if (zip64) {
      const recordAt = this.pos
      const r = Buffer.alloc(56)
      r.writeUInt32LE(0x06064b50, 0)
      r.writeBigUInt64LE(44n, 4)
      r.writeUInt16LE(45, 12)
      r.writeUInt16LE(45, 14)
      r.writeUInt32LE(0, 16)
      r.writeUInt32LE(0, 20)
      r.writeBigUInt64LE(BigInt(count), 24)
      r.writeBigUInt64LE(BigInt(count), 32)
      r.writeBigUInt64LE(BigInt(cdSize), 40)
      r.writeBigUInt64LE(BigInt(cdStart), 48)
      const l = Buffer.alloc(20)
      l.writeUInt32LE(0x07064b50, 0)
      l.writeUInt32LE(0, 4)
      l.writeBigUInt64LE(BigInt(recordAt), 8)
      l.writeUInt32LE(1, 16)
      await this.write(Buffer.concat([r, l]))
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(zip64 ? Math.min(count, 0xffff) : count, 8)
    end.writeUInt16LE(zip64 ? Math.min(count, 0xffff) : count, 10)
    end.writeUInt32LE(zip64 ? Math.min(cdSize, U32) : cdSize, 12)
    end.writeUInt32LE(zip64 ? U32 : cdStart, 16)
    end.writeUInt16LE(0, 20)
    if (zip64 && count < 0xffff) {
      end.writeUInt16LE(count, 8)
      end.writeUInt16LE(count, 10)
    }
    await this.write(end)
    await this.fh.truncate(this.pos) // nothing may follow the end record (readers look for it at the end)
    await this.fh.close()
    this.fh = null
    const target = uniquePath(this.file)
    await fsp.rename(this.temp, target)
    this.file = target
    return target
  }

  async abort() {
    await this.fh?.close().catch(() => {})
    this.fh = null
    await fsp.rm(this.temp, { force: true }).catch(() => {})
  }
}

// ── the export ──────────────────────────────────────────────────────────────

const LOOKAHEAD = 4

/**
 * Exports `items` (library items) with `options`. Resolves to an ExportResult:
 *   { ok, canceled, kind: 'folder' | 'zip', destination, count, total, bytes, failed,
 *     errors: ["name: reason"], converted, keptVideoDetails, keptVideoTracks, ms }
 * (keptVideoDetails: videos whose details couldn't all be removed; keptVideoTracks: those of them
 * with a GPS / telemetry track — GoPro, DJI… — that stays in the copy.)
 * `getSource(item)` → full-size path or JPEG buffer for HEIC / RAW (thumbs.source).
 * `onProgress({ done, total, bytes, current, fraction })` is called often (throttle when forwarding).
 * `signal` (AbortSignal) cancels: a .zip is deleted, a folder keeps the files already finished.
 * `onFile(path)`: each file written into a folder, or the finished .zip (e.g. for main.cjs' ownFiles()).
 */
async function runExport(items, options, { getSource, signal, onProgress, onFile, label = '', forceZip64 = false } = {}) {
  const started = Date.now()
  const o = normalizeOptions(options)
  const kind = o.destination
  const target = kind === 'zip' ? o.zipPath : o.folder
  const plan = planNames(items, o, { label })
  const result = { ok: false, canceled: false, kind, destination: target ?? '', count: 0, total: plan.length, bytes: 0, failed: 0, errors: [], converted: 0, keptVideoDetails: 0, keptVideoTracks: 0, ms: 0 }
  if (!target || !plan.length) {
    result.errors.push(!target ? 'Choose where to save the export first.' : 'Nothing to export.')
    return result
  }
  const writer = kind === 'zip' ? new ZipWriter(target, { forceZip64 }) : new FolderWriter(target)
  let current = ''
  let currentBytes = 0
  let currentSize = 0
  const progress = () =>
    onProgress?.({
      done: result.count + result.failed,
      total: plan.length,
      bytes: result.bytes,
      current,
      fraction: plan.length ? Math.min(1, (result.count + result.failed + (currentSize ? currentBytes / currentSize : 0)) / plan.length) : 1,
    })

  const pending = new Map()
  const start = (i) => {
    if (i >= plan.length || pending.has(i)) return
    const { item, name } = plan[i]
    pending.set(
      i,
      prepare(item, name, o, getSource).then(
        (prepared) => ({ prepared }),
        (error) => ({ error }),
      ),
    )
  }

  try {
    await writer.open()
    for (let i = 0; i < Math.min(LOOKAHEAD, plan.length); i++) start(i)
    progress()
    for (let i = 0; i < plan.length; i++) {
      if (signal?.aborted) throw abortError()
      const { item, name } = plan[i]
      current = name
      currentBytes = 0
      currentSize = item.size || 0
      progress()
      const res = await pending.get(i)
      pending.delete(i)
      start(i + LOOKAHEAD)
      if (signal?.aborted) throw abortError()
      if (res.error) {
        result.failed++
        result.errors.push(`${item.name}: ${res.error?.message ?? res.error}`)
        continue
      }
      const p = res.prepared
      currentSize = p.kind === 'buffer' ? p.data.length : p.size
      let last = 0
      try {
        const written = await writer.add(name, p, {
          signal,
          onBytes: (n) => {
            currentBytes += n
            result.bytes += n
            const now = Date.now()
            if (now - last > 120) {
              last = now
              progress()
            }
          },
        })
        if (kind === 'folder') onFile?.(written)
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        // Disk full or the destination went away: stop rather than fail every file the same way.
        // (The same codes while reading the photo itself only fail that photo.)
        if (!err?.readingSource && ['ENOSPC', 'EROFS', 'EACCES', 'EPERM', 'ENOENT', 'EIO'].includes(err?.code)) throw err
        result.failed++
        result.errors.push(`${item.name}: ${err?.readingSource ? unreadable(err) : (err?.message ?? err)}`)
        continue
      }
      result.count++
      if (p.converted) result.converted++
      if (p.keptVideoDetails) result.keptVideoDetails++
      if (p.keptVideoTrack) result.keptVideoTracks++
    }
    current = ''
    currentSize = 0
    result.destination = await writer.close()
    if (kind === 'zip') onFile?.(result.destination)
    result.ok = result.failed === 0
    progress()
  } catch (err) {
    await writer.abort()
    if (err?.name === 'AbortError') result.canceled = true
    else result.errors.unshift(friendlyError(err))
    if (kind === 'zip') {
      result.count = 0
      result.bytes = 0
    }
  }
  result.ms = Date.now() - started
  return result
}

/** Why a photo couldn't be read for exporting, in plain words. */
function unreadable(err) {
  if (err?.code === 'ENOENT') return 'the file is no longer there'
  if (err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EBUSY') return "the file couldn't be read (another program may have it open)"
  if (err?.code === 'EIO') return "the drive couldn't read the file"
  return `the file couldn't be read: ${err?.message ?? err}`
}

function friendlyError(err) {
  if (err?.code === 'ENOSPC') return 'There is not enough free space on the drive.'
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return "Pics isn't allowed to write there. Choose another folder."
  if (err?.code === 'EROFS') return "That drive can't be written to."
  return String(err?.message ?? err)
}

// ── IPC (optional helper for main.cjs) ─────────────────────────────────────

/**
 * Registers the export IPC handlers:
 *   export:defaults (label)               → { folder, zip, root, options }
 *   export:pick (kind, current)           → chosen folder / .zip path, or null
 *   export:start (ids, options, label)    → ExportResult (one export at a time)
 *   export:cancel ()                      → void
 *   export:reveal (path)                  → shows the folder / the .zip in Explorer
 * and sends 'export:progress' ({ done, total, bytes, current, fraction } | null when finished).
 * deps: { ipcMain, dialog, shell, app, store, getWindow(), itemsFor(ids), getSource(item), send(channel, payload),
 *         onWritten?(paths) — called for every exported file / the .zip (pass ownFiles so exports into a library folder aren't 'new duplicates') }
 * store key: exportOptions (the last options, without destinations).
 */
function registerIpc({ ipcMain, dialog, shell, app, store, getWindow, itemsFor, getSource, send, onWritten }) {
  let running = null
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

  ipcMain.handle('export:defaults', (_e, label) => {
    const d = defaultDestinations(app.getPath('pictures'), typeof label === 'string' ? label : '')
    const saved = store.get('exportOptions')
    return { ...d, options: saved && typeof saved === 'object' ? saved : null }
  })

  ipcMain.handle('export:pick', async (_e, kind, current) => {
    const win = getWindow()
    const start = typeof current === 'string' && path.isAbsolute(current) ? current : path.join(app.getPath('pictures'), 'Pics exports')
    if (kind === 'zip') {
      const res = await dialog.showSaveDialog(win, { title: 'Save the export as a .zip file', defaultPath: start, filters: [{ name: 'Zip file', extensions: ['zip'] }] })
      return res.canceled || !res.filePath ? null : res.filePath
    }
    const res = await dialog.showOpenDialog(win, { title: 'Export into this folder', defaultPath: start, properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  ipcMain.handle('export:start', async (_e, list, options, label) => {
    if (running) return { ok: false, canceled: false, errors: ['Another export is still running.'], count: 0, total: 0, bytes: 0, failed: 0 }
    const items = itemsFor(ids(list))
    const o = normalizeOptions(options)
    const { folder, zipPath, ...keep } = o
    store.set({ exportOptions: keep })
    running = new AbortController()
    let last = 0
    try {
      const result = await runExport(items, o, {
        getSource,
        signal: running.signal,
        label: typeof label === 'string' ? label : '',
        onFile: (p) => onWritten?.([p]),
        onProgress: (p) => {
          const now = Date.now()
          if (now - last < 100 && p.done < p.total) return
          last = now
          send('export:progress', p)
        },
      })
      return result
    } finally {
      running = null
      send('export:progress', null)
    }
  })

  ipcMain.handle('export:cancel', () => running?.abort())

  ipcMain.handle('export:reveal', (_e, p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) return
    if (fs.statSync(p).isDirectory()) shell.openPath(p)
    else shell.showItemInFolder(p)
  })

  return { cancel: () => running?.abort(), get running() { return !!running } }
}

module.exports = {
  SIZES,
  DEFAULTS,
  PRESETS,
  normalizeOptions,
  safeName,
  outputExt,
  planNames,
  defaultLabel,
  defaultDestinations,
  runExport,
  registerIpc,
  // exposed for tests
  scrubJpeg,
  scrubPng,
  scrubWebp,
  scrubTiffGps,
  videoPatches,
  ZipWriter,
}
