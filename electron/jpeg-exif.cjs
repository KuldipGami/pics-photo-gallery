const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { writeAtomicSync, readJson, renameRetry } = require('./safe-file.cjs')

// Lossless JPEG metadata edits (ported from DupeLens' JpegExif): changes the date taken, the
// orientation and the GPS position stored in a JPEG without touching the compressed image data
// (SOS…EOI is copied byte for byte). Existing EXIF values are patched in place. When the EXIF block
// lacks a field, the block is grown append-only: every existing byte keeps its offset (so GPS, the
// IFD1 thumbnail and maker notes stay valid), and only the IFD that gains an entry is copied, with
// that entry, to the end of the block. A file with no EXIF at all (typical for WhatsApp) gets a
// small new EXIF block after APP0/JFIF.

const TAG_ORIENTATION = 0x0112
const TAG_DATETIME = 0x0132
const TAG_EXIF_POINTER = 0x8769
const TAG_GPS_POINTER = 0x8825
const TAG_DATE_ORIGINAL = 0x9003
const TAG_DATE_DIGITIZED = 0x9004
// GPS IFD
const GPS_VERSION = 0x0000
const GPS_LAT_REF = 0x0001
const GPS_LAT = 0x0002
const GPS_LON_REF = 0x0003
const GPS_LON = 0x0004
const BYTE = 1
const ASCII = 2
const SHORT = 3
const LONG = 4
const RATIONAL = 5

const MSG = {
  notJpeg: 'Only JPEG photos can be changed without re-saving.',
  invalid: 'Not a valid JPEG file.',
  unreadable: "The photo's EXIF data couldn't be read.",
  noRoom: 'This photo has no room to add the field without re-saving it.',
  badDate: "The date isn't valid.",
  badOrientation: 'The orientation must be a number from 1 to 8.',
  badLocation: "The location isn't valid.",
  busy: 'The photo is open in another program. Close it and try again.',
  readOnly: 'The photo is read-only. Turn off "Read-only" in its Properties in File Explorer to change it.',
}

const JPEG_EXTS = new Set(['jpg', 'jpeg', 'jpe', 'jfif'])

/** True for a JPEG extension ("jpg", ".JPEG") or a path ending in one. */
function isJpeg(ext) {
  const s = String(ext ?? '').toLowerCase()
  return JPEG_EXTS.has(s.slice(s.lastIndexOf('.') + 1))
}

// ── byte helpers ─────────────────────────────────────────────────────────────
const rd16 = (b, o, le) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
const rd32 = (b, o, le) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
const wr16 = (b, o, v, le) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o))
const wr32 = (b, o, v, le) => (le ? b.writeUInt32LE(v >>> 0, o) : b.writeUInt32BE(v >>> 0, o))

/** "yyyy:MM:dd HH:mm:ss" in local time (EXIF dates have no time zone; exifr reads them as local). */
function exifDate(taken) {
  const d = taken instanceof Date ? taken : new Date(typeof taken === 'string' ? taken : Number(taken))
  if (!Number.isFinite(d.getTime())) return null
  const y = d.getFullYear()
  if (y < 1 || y > 9999) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${String(y).padStart(4, '0')}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 20 bytes: the 19-character date + NUL. */
const dateBytes = (text) => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(1)])

/** { lat, lon } in degrees (WGS 84), or null when missing or out of range. */
function validGps(gps) {
  const lat = Number(gps?.lat)
  const lon = Number(gps?.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

/** 24 bytes: degrees, minutes, seconds as three RATIONALs (d/1, m/1, s·10⁴/10⁴ — about 3 mm). */
function dmsBytes(value, le) {
  const total = Math.round(Math.abs(value) * 36_000_000) // in 1/10000 arc seconds
  const parts = [
    [Math.floor(total / 36_000_000), 1],
    [Math.floor((total % 36_000_000) / 600_000), 1],
    [total % 600_000, 10_000],
  ]
  const b = Buffer.alloc(24)
  parts.forEach(([n, d], i) => {
    wr32(b, i * 8, n, le)
    wr32(b, i * 8 + 4, d, le)
  })
  return b
}

/** A GPS reference entry ("N"/"S"/"E"/"W" + NUL), stored inline. */
function refEntry(tag, letter, le) {
  const e = entryBytes(tag, ASCII, 2, 0, le)
  e.write(letter, 8, 'latin1')
  return e
}

/** GPSVersionID 2.3.0.0 (four BYTEs, inline). */
function versionEntry(le) {
  const e = entryBytes(GPS_VERSION, BYTE, 4, 0, le)
  e.set([2, 3, 0, 0], 8)
  return e
}

const latRef = (gps) => (gps.lat < 0 ? 'S' : 'N')
const lonRef = (gps) => (gps.lon < 0 ? 'W' : 'E')

/**
 * Walks the JPEG header up to the start of scan. Returns null for a broken file, otherwise
 * { sos, insertAt, exif: { seg, tiff, length } | null, segments: [{ pos, marker, len }] }.
 */
function scanJpeg(d) {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return null
  let pos = 2
  let insertAt = 2
  let exif = null
  const segments = []
  while (pos + 1 < d.length) {
    if (d[pos] !== 0xff) return null
    const marker = d[pos + 1]
    if (marker === 0xff) {
      pos++ // fill byte
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2 // markers without a length
      continue
    }
    if (marker === 0xda) return { sos: pos, insertAt, exif, segments }
    if (marker === 0xd8 || marker === 0xd9 || pos + 4 > d.length) return null
    const len = d.readUInt16BE(pos + 2)
    if (len < 2 || pos + 2 + len > d.length) return null
    segments.push({ pos, marker, len })
    if (marker === 0xe0 && pos === insertAt) insertAt = pos + 2 + len // keep JFIF first
    if (!exif && marker === 0xe1 && len >= 8 && d.toString('latin1', pos + 4, pos + 8) === 'Exif')
      exif = { seg: pos, tiff: pos + 10, length: len - 8 }
    pos += 2 + len
  }
  return null
}

/** Reads an IFD: { off, entries: [{ tag, type, count, at }], next } or null when out of range. */
function readIfd(t, off, le) {
  if (!Number.isInteger(off) || off < 8 || off + 2 > t.length) return null
  const n = rd16(t, off, le)
  if (off + 2 + n * 12 > t.length) return null
  const entries = []
  for (let i = 0; i < n; i++) {
    const at = off + 2 + i * 12
    entries.push({ tag: rd16(t, at, le), type: rd16(t, at + 2, le), count: rd32(t, at + 4, le), at })
  }
  const nextAt = off + 2 + n * 12
  return { off, entries, next: nextAt + 4 <= t.length ? rd32(t, nextAt, le) : 0 }
}

function entryBytes(tag, type, count, value, le) {
  const e = Buffer.alloc(12)
  wr16(e, 0, tag, le)
  wr16(e, 2, type, le)
  wr32(e, 4, count, le)
  if (type === SHORT) wr16(e, 8, value, le)
  else wr32(e, 8, value, le)
  return e
}

/** An IFD from 12-byte entries (sorted by tag, as TIFF requires) and the next-IFD pointer. */
function ifdBytes(entries, next, le) {
  const sorted = [...entries].sort((a, b) => rd16(a, 0, le) - rd16(b, 0, le))
  const b = Buffer.alloc(2 + sorted.length * 12 + 4)
  wr16(b, 0, sorted.length, le)
  sorted.forEach((e, i) => e.copy(b, 2 + i * 12))
  wr32(b, 2 + sorted.length * 12, next, le)
  return b
}

/**
 * Applies the edit to a copy of the TIFF data from an EXIF block. Returns { tiff } (same length
 * when everything could be patched in place, longer when fields had to be added) or { error }.
 * `gps`: { lat, lon } | null.
 */
function editTiff(src, date, orientation, gps = null) {
  if (src.length < 8) return { error: MSG.unreadable }
  const order = src.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return { error: MSG.unreadable }
  const le = order === 'II'
  if (rd16(src, 2, le) !== 42) return { error: MSG.unreadable }
  const t = Buffer.from(src)

  const ifd0 = readIfd(t, rd32(t, 4, le), le)
  if (!ifd0) return { error: MSG.unreadable }
  const find = (ifd, tag) => ifd?.entries.find((e) => e.tag === tag)

  // Patches a date string in place when the entry has room for it (as DupeLens does).
  const writeAscii = (e) => {
    if (!e || e.count < 20 || (e.type !== ASCII && e.type !== 7)) return false
    const off = rd32(t, e.at + 8, le)
    if (off < 8 || off + 20 > t.length) return false
    t.write(date, off, 19, 'latin1')
    t[off + 19] = 0
    return true
  }

  // 1. In place: orientation (normalised to SHORT ×1), DateTime, DateTimeOriginal/Digitized.
  const orientEntry = find(ifd0, TAG_ORIENTATION)
  if (orientation != null && orientEntry) entryBytes(TAG_ORIENTATION, SHORT, 1, orientation, le).copy(t, orientEntry.at)
  const dateTimeEntry = find(ifd0, TAG_DATETIME)
  const dateTimeOk = date == null || !dateTimeEntry || writeAscii(dateTimeEntry)

  const exifPtr = find(ifd0, TAG_EXIF_POINTER)
  const exifIfd = exifPtr ? readIfd(t, rd32(t, exifPtr.at + 8, le), le) : null
  const originalEntry = find(exifIfd, TAG_DATE_ORIGINAL)
  const digitizedEntry = find(exifIfd, TAG_DATE_DIGITIZED)
  let originalOk = date == null
  let digitizedOk = date == null
  if (date != null) {
    originalOk = writeAscii(originalEntry)
    digitizedOk = writeAscii(digitizedEntry)
  }

  // GPS: a photo that already has a position gets the new one written over it. The references are
  // inline values (the 12-byte entry is simply rewritten); latitude/longitude are patched in place
  // when they are three RATIONALs, otherwise they are redirected to new values further down.
  const gpsPtr = gps ? find(ifd0, TAG_GPS_POINTER) : null
  const gpsIfd = gpsPtr ? readIfd(t, rd32(t, gpsPtr.at + 8, le), le) : null
  const gpsEntries = {
    latRef: find(gpsIfd, GPS_LAT_REF),
    lat: find(gpsIfd, GPS_LAT),
    lonRef: find(gpsIfd, GPS_LON_REF),
    lon: find(gpsIfd, GPS_LON),
  }
  const writeDms = (e, value) => {
    if (!e || e.type !== RATIONAL || e.count !== 3) return false
    const off = rd32(t, e.at + 8, le)
    if (off < 8 || off + 24 > t.length) return false
    dmsBytes(value, le).copy(t, off)
    return true
  }
  let latOk = true
  let lonOk = true
  if (gps) {
    if (gpsEntries.latRef) refEntry(GPS_LAT_REF, latRef(gps), le).copy(t, gpsEntries.latRef.at)
    if (gpsEntries.lonRef) refEntry(GPS_LON_REF, lonRef(gps), le).copy(t, gpsEntries.lonRef.at)
    latOk = writeDms(gpsEntries.lat, gps.lat)
    lonOk = writeDms(gpsEntries.lon, gps.lon)
  }
  const gpsDone = !gps || (latOk && lonOk && !!gpsEntries.latRef && !!gpsEntries.lonRef)

  const orientationDone = orientation == null || !!orientEntry
  if (orientationDone && originalOk && gpsDone) return { tiff: t } // everything fitted

  // 2. Append-only growth. Existing bytes never move; new values and the IFDs that gain an entry
  //    are added after them, and the pointers to those IFDs are redirected.
  const parts = []
  let end = t.length
  const append = (buf) => {
    if (end % 2) {
      parts.push(Buffer.alloc(1)) // TIFF values and IFDs start on a word boundary
      end++
    }
    const at = end
    parts.push(buf)
    end += buf.length
    return at
  }

  const ifd0Added = []
  if (!orientationDone) ifd0Added.push(entryBytes(TAG_ORIENTATION, SHORT, 1, orientation, le))

  if (date != null) {
    // Entries that exist but couldn't hold the date are pointed at a new string, in place.
    const redirect = (e) => entryBytes(e.tag, ASCII, 20, append(dateBytes(date)), le).copy(t, e.at)
    if (dateTimeEntry && !dateTimeOk) redirect(dateTimeEntry)
    if (originalEntry && !originalOk) redirect(originalEntry)
    if (digitizedEntry && !digitizedOk) redirect(digitizedEntry)

    const exifAdded = []
    if (!originalEntry) exifAdded.push(entryBytes(TAG_DATE_ORIGINAL, ASCII, 20, append(dateBytes(date)), le))
    if (!digitizedEntry) exifAdded.push(entryBytes(TAG_DATE_DIGITIZED, ASCII, 20, append(dateBytes(date)), le))
    if (exifAdded.length) {
      const old = (exifIfd?.entries ?? []).map((e) => t.subarray(e.at, e.at + 12))
      const newExif = append(ifdBytes([...old, ...exifAdded], exifIfd?.next ?? 0, le))
      const pointer = entryBytes(TAG_EXIF_POINTER, LONG, 1, newExif, le)
      if (exifPtr) pointer.copy(t, exifPtr.at)
      else ifd0Added.push(pointer)
    }
  }

  if (!gpsDone) {
    const dms = (tag, value) => entryBytes(tag, RATIONAL, 3, append(dmsBytes(value, le)), le)
    // latitude/longitude entries in an unexpected form are pointed at new values, in place
    if (gpsEntries.lat && !latOk) dms(GPS_LAT, gps.lat).copy(t, gpsEntries.lat.at)
    if (gpsEntries.lon && !lonOk) dms(GPS_LON, gps.lon).copy(t, gpsEntries.lon.at)
    const gpsAdded = []
    if (!gpsIfd) gpsAdded.push(versionEntry(le))
    if (!gpsEntries.latRef) gpsAdded.push(refEntry(GPS_LAT_REF, latRef(gps), le))
    if (!gpsEntries.lat) gpsAdded.push(dms(GPS_LAT, gps.lat))
    if (!gpsEntries.lonRef) gpsAdded.push(refEntry(GPS_LON_REF, lonRef(gps), le))
    if (!gpsEntries.lon) gpsAdded.push(dms(GPS_LON, gps.lon))
    if (gpsAdded.length) {
      const old = (gpsIfd?.entries ?? []).map((e) => t.subarray(e.at, e.at + 12))
      const newGps = append(ifdBytes([...old, ...gpsAdded], gpsIfd?.next ?? 0, le))
      const pointer = entryBytes(TAG_GPS_POINTER, LONG, 1, newGps, le)
      if (gpsPtr) pointer.copy(t, gpsPtr.at)
      else ifd0Added.push(pointer)
    }
  }

  if (ifd0Added.length) {
    const old = ifd0.entries.map((e) => t.subarray(e.at, e.at + 12))
    wr32(t, 4, append(ifdBytes([...old, ...ifd0Added], ifd0.next, le)), le)
  }
  return { tiff: Buffer.concat([t, ...parts]) }
}

/**
 * A minimal little-endian EXIF APP1 segment with orientation and (optionally) the date taken and a
 * GPS position. Layout: header · IFD0 · Exif IFD · GPS IFD · three date strings · GPS rationals.
 */
function buildExifSegment(date, orientation, gps = null) {
  const le = true
  const hasDate = date != null
  const ifd0Count = 1 + (hasDate ? 2 : 0) + (gps ? 1 : 0)
  const exifOffset = 8 + 2 + ifd0Count * 12 + 4
  const gpsOffset = exifOffset + (hasDate ? 2 + 2 * 12 + 4 : 0)
  const dataOffset = gpsOffset + (gps ? 2 + 5 * 12 + 4 : 0) // three 20-byte date strings follow
  const gpsData = dataOffset + (hasDate ? 60 : 0) // then latitude and longitude, 24 bytes each
  const ifd0 = [entryBytes(TAG_ORIENTATION, SHORT, 1, orientation, le)]
  if (hasDate) {
    ifd0.push(entryBytes(TAG_DATETIME, ASCII, 20, dataOffset, le))
    ifd0.push(entryBytes(TAG_EXIF_POINTER, LONG, 1, exifOffset, le))
  }
  if (gps) ifd0.push(entryBytes(TAG_GPS_POINTER, LONG, 1, gpsOffset, le))
  const parts = [Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]), ifdBytes(ifd0, 0, le)]
  if (hasDate) {
    const exif = [
      entryBytes(TAG_DATE_ORIGINAL, ASCII, 20, dataOffset + 20, le),
      entryBytes(TAG_DATE_DIGITIZED, ASCII, 20, dataOffset + 40, le),
    ]
    parts.push(ifdBytes(exif, 0, le))
  }
  if (gps) {
    const entries = [
      versionEntry(le),
      refEntry(GPS_LAT_REF, latRef(gps), le),
      entryBytes(GPS_LAT, RATIONAL, 3, gpsData, le),
      refEntry(GPS_LON_REF, lonRef(gps), le),
      entryBytes(GPS_LON, RATIONAL, 3, gpsData + 24, le),
    ]
    parts.push(ifdBytes(entries, 0, le))
  }
  if (hasDate) parts.push(dateBytes(date), dateBytes(date), dateBytes(date))
  if (gps) parts.push(dmsBytes(gps.lat, le), dmsBytes(gps.lon, le))
  const tiff = Buffer.concat(parts)
  const head = Buffer.from([0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0])
  head.writeUInt16BE(8 + tiff.length, 2)
  return Buffer.concat([head, tiff])
}

/** An APP2 Multi-Picture (MPF) block stores file offsets; growing anything before it would break them. */
const mpfBefore = (data, scan, pos) =>
  scan.segments.some((s) => s.pos < pos && s.marker === 0xe2 && s.len >= 6 && data.toString('latin1', s.pos + 4, s.pos + 8) === 'MPF\0')

/**
 * The new file contents, or { error }. Pure: works on a buffer, never on disk.
 * `taken`: Date | ms | null, `orientation`: 1..8 | null, `gps`: { lat, lon } (degrees) | null.
 */
function applyExif(data, { taken, orientation, gps } = {}) {
  if (!Buffer.isBuffer(data) || data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return { error: MSG.invalid }
  const date = taken == null ? null : exifDate(taken)
  if (taken != null && date == null) return { error: MSG.badDate }
  if (orientation != null && !(Number.isInteger(orientation) && orientation >= 1 && orientation <= 8))
    return { error: MSG.badOrientation }
  const position = gps == null ? null : validGps(gps)
  if (gps != null && !position) return { error: MSG.badLocation }
  const scan = scanJpeg(data)
  if (!scan) return { error: MSG.invalid }

  let result
  if (!scan.exif) {
    // No EXIF: insert a minimal block right after SOI / APP0.
    if (mpfBefore(data, scan, scan.insertAt)) return { error: MSG.noRoom }
    const block = buildExifSegment(date, orientation ?? 1, position)
    result = Buffer.concat([data.subarray(0, scan.insertAt), block, data.subarray(scan.insertAt)])
  } else {
    const { seg, tiff, length } = scan.exif
    const edited = editTiff(data.subarray(tiff, tiff + length), date, orientation, position)
    if (edited.error) return edited
    if (edited.tiff.length === length) {
      result = Buffer.from(data)
      edited.tiff.copy(result, tiff)
    } else {
      // The block grew: it must still fit in one APP1 segment, and nothing before it may hold offsets.
      if (8 + edited.tiff.length > 0xffff || mpfBefore(data, scan, seg)) return { error: MSG.noRoom }
      const head = Buffer.from(data.subarray(seg, tiff))
      head.writeUInt16BE(8 + edited.tiff.length, 2)
      result = Buffer.concat([data.subarray(0, seg), head, edited.tiff, data.subarray(tiff + length)])
    }
  }

  // Safety net: the compressed image (and anything after it) must be byte-identical.
  const grown = result.length - data.length
  const after = scanJpeg(result)
  if (!after || after.sos !== scan.sos + grown || !result.subarray(after.sos).equals(data.subarray(scan.sos)))
    return { error: MSG.unreadable }
  return { data: result }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const RETRY = new Set(['EBUSY', 'EPERM', 'EACCES'])

/** Runs fn, retrying 15 × 150 ms while another program has the file open. */
async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!RETRY.has(err.code) || attempt >= 15) throw err
      await sleep(150) // usually a preview still being read; it finishes in a moment
    }
  }
}

// ── swapping a rewritten file in ─────────────────────────────────────────────
// For a moment during a swap the photo exists only under its "old" name. Every swap in progress is
// listed in a journal file (setSwapJournal), written before the first rename and updated once the
// swap is done, so if Pics is closed or crashes in between, recoverSwaps() at the next start puts
// the photo back. Each swap uses names of its own, so two writers never share a temp or old file.

let journalFile = null
const swaps = new Map() // id → { id, file, temp, old }

/** Where the journal of swaps in progress is kept (e.g. <userData>/pending-swaps.json). */
function setSwapJournal(file) {
  journalFile = file || null
}

function saveJournal() {
  if (!journalFile) return
  try {
    writeAtomicSync(journalFile, JSON.stringify({ version: 1, swaps: [...swaps.values()] }))
  } catch (err) {
    console.error('Failed to save the swap journal', err) // the swap itself still goes ahead
  }
}

/** Unique temp and old names for one swap of `file` (temp: the caller's own, when it made one). */
function track(file, temp) {
  const id = crypto.randomBytes(6).toString('hex')
  const entry = { id, file, temp: temp ?? `${file}.lumen-${id}.tmp`, old: `${file}.lumen-${id}.old` }
  swaps.set(id, entry)
  saveJournal()
  return entry
}

function untrack(entry) {
  if (swaps.delete(entry.id)) saveJournal()
}

/** Fails with a clear message for a read-only file (renaming would silently clear the flag). */
async function assertWritable(file) {
  const st = await fsp.stat(file)
  if (!(st.mode & 0o222)) throw Object.assign(new Error(MSG.readOnly), { code: 'READONLY' })
}

/**
 * The swap itself (see replaceWithTemp). The journal entry is dropped once nothing is left over;
 * if the original couldn't even be put back, it stays, so the next start can.
 */
async function swapIn(entry) {
  const { file, temp, old } = entry
  try {
    await assertWritable(file)
    await withRetry(() => fsp.rename(file, old))
  } catch (err) {
    await fsp.unlink(temp).catch(() => {})
    untrack(entry)
    throw err
  }
  try {
    await withRetry(() => fsp.rename(temp, file))
  } catch (err) {
    try {
      await withRetry(() => fsp.rename(old, file)) // put the original back
    } catch {
      throw err // the photo is only "<name>.lumen-….old" now: the journal keeps the entry for recoverSwaps()
    }
    await fsp.unlink(temp).catch(() => {})
    untrack(entry)
    throw err
  }
  try {
    await withRetry(() => fsp.unlink(old))
  } catch (err) {
    if (err?.code !== 'ENOENT' && existsSync(old)) {
      // The swap is done; only the old copy is left (antivirus or a viewer still has it open). It
      // is tried again in a while, and stays listed until then, so recoverSwaps() removes it otherwise.
      entry.done = true
      saveJournal()
      const later = setTimeout(() => fsp.unlink(old).then(() => untrack(entry), () => {}), 10_000)
      later.unref?.()
      return
    }
  }
  untrack(entry)
}

/**
 * Moves a finished temp file over `file`, waiting briefly if another program has it open. The
 * original is renamed away first and the temp renamed into its name (instead of one rename over
 * it): on NTFS that keeps the photo's "Date created", which a plain replace would reset to now.
 * On failure the original is left (or put back) in place and the temp is deleted. A read-only
 * file isn't touched (error code 'READONLY').
 */
async function replaceWithTemp(temp, file) {
  await swapIn(track(file, temp))
}

/**
 * Writes bytes to a temp file next to `file` ("<name>.lumen-<id>.tmp") and swaps it in, so a
 * viewer reading the file doesn't block the edit.
 */
async function replaceFile(file, bytes) {
  await assertWritable(file)
  const entry = track(file)
  let fh
  try {
    fh = await fsp.open(entry.temp, 'wx')
    await fh.writeFile(bytes)
    await fh.sync()
    await fh.close()
    fh = null
  } catch (err) {
    await fh?.close().catch(() => {})
    await fsp.unlink(entry.temp).catch(() => {})
    untrack(entry)
    throw err
  }
  await swapIn(entry)
}

const existsSync = (p) => {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

/** The compressed picture of a JPEG (start of scan to the end of the file), or null. */
function imageData(data) {
  const scan = scanJpeg(data)
  return scan ? data.subarray(scan.sos) : null
}

/**
 * True when both files are JPEGs with byte-identical compressed pictures: the same photo, whatever
 * Pics' lossless edits (date, rotation, place, rating, tags) changed in their headers.
 */
async function sameImageData(a, b) {
  try {
    const [x, y] = await Promise.all([fsp.readFile(a), fsp.readFile(b)])
    const dx = imageData(x)
    const dy = imageData(y)
    return !!dx && !!dy && dx.equals(dy)
  } catch {
    return false
  }
}

/** "IMG_1.jpg" → "IMG_1 (2).jpg", "IMG_1 (3).jpg"… until the name is free. */
function freeName(file) {
  const ext = path.extname(file)
  const stem = file.slice(0, file.length - ext.length)
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!existsSync(candidate)) return candidate
  }
}

/**
 * At start-up, before anything rewrites files: finishes what the journal says was cut off.
 * - The photo is missing and its old copy is there → the old copy goes back under its name (the
 *   edit is dropped; tag writes are still marked in tags.json and are redone).
 * - The photo is there → leftover temp files are deleted, and an old copy too once it is known to be
 *   the same picture (otherwise it is kept, renamed "<name> (2).jpg" so it shows in the library).
 * - A swap that had finished but whose old copy couldn't be deleted (`done`) → that old copy goes.
 * Entries that couldn't be handled stay in the journal for next time. Never rejects; resolves to
 * { restored, cleaned, kept: [paths kept under a new name], left }.
 */
async function recoverSwaps() {
  const out = { restored: 0, cleaned: 0, kept: [], left: 0 }
  if (!journalFile) return out
  const read = await readJson(journalFile)
  if (read.error) {
    console.error('The swap journal could not be read; it is left as it is', read.error)
    journalFile = null // never written over this session
    return out
  }
  if (read.corrupt) console.error('The swap journal was damaged; kept as', read.keptAs)
  const listed = Array.isArray(read.data?.swaps) ? read.data.swaps : []
  for (const s of listed) {
    if (!s || typeof s.file !== 'string' || typeof s.old !== 'string' || typeof s.temp !== 'string') continue
    try {
      if (s.done) {
        // the photo had its new version; it may have been moved or deleted since, so never put this back
        if (existsSync(s.old) && (!existsSync(s.file) || (await sameImageData(s.old, s.file)))) {
          await fsp.unlink(s.old)
          out.cleaned++
        } else if (existsSync(s.old)) {
          const keptAs = freeName(s.file)
          await renameRetry(s.old, keptAs)
          out.kept.push(keptAs)
        }
        continue
      }
      if (!existsSync(s.file)) {
        if (existsSync(s.old)) {
          await renameRetry(s.old, s.file)
          await fsp.unlink(s.temp).catch(() => {})
          out.restored++
        } else if (existsSync(s.temp)) {
          await renameRetry(s.temp, s.file) // only the finished new version is left: keep that
          out.restored++
        }
        continue // otherwise the photo was moved or deleted since: nothing to do
      }
      if (existsSync(s.temp)) {
        await fsp.unlink(s.temp)
        out.cleaned++
      }
      if (existsSync(s.old)) {
        if (await sameImageData(s.old, s.file)) {
          await fsp.unlink(s.old)
          out.cleaned++
        } else {
          const keptAs = freeName(s.file)
          await renameRetry(s.old, keptAs)
          out.kept.push(keptAs)
        }
      }
    } catch (err) {
      console.error('Could not finish an interrupted photo rewrite', s.file, err)
      const id = typeof s.id === 'string' ? s.id : crypto.randomBytes(6).toString('hex')
      swaps.set(id, { id, file: s.file, temp: s.temp, old: s.old, ...(s.done ? { done: true } : {}) }) // try again next time
      out.left++
    }
  }
  saveJournal()
  return out
}

/**
 * Changes the date taken, orientation and/or GPS position ({ lat, lon }) of a JPEG losslessly.
 * Resolves null on success, otherwise a short reason (never rejects).
 */
async function writeExif(file, { taken, orientation, gps } = {}) {
  if (!isJpeg(file)) return MSG.notJpeg
  if (taken == null && orientation == null && gps == null) return null
  try {
    const out = applyExif(await fsp.readFile(file), { taken, orientation, gps })
    if (out.error) return out.error
    await replaceFile(file, out.data)
    return null
  } catch (err) {
    return RETRY.has(err?.code) ? MSG.busy : String(err?.message ?? err)
  }
}

/** The EXIF orientation (1..8) of a JPEG buffer; 1 when there is none. */
function orientationOf(data) {
  const scan = scanJpeg(data)
  if (!scan?.exif) return 1
  const t = data.subarray(scan.exif.tiff, scan.exif.tiff + scan.exif.length)
  if (t.length < 8) return 1
  const order = t.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return 1
  const le = order === 'II'
  const e = readIfd(t, rd32(t, 4, le), le)?.entries.find((x) => x.tag === TAG_ORIENTATION)
  if (!e) return 1
  const v = e.type === LONG ? rd32(t, e.at + 8, le) : rd16(t, e.at + 8, le)
  return v >= 1 && v <= 8 ? v : 1
}

/** Reads a JPEG's current orientation from its header (1 when absent or unreadable). */
async function readOrientation(file) {
  const fh = await fsp.open(file, 'r')
  try {
    // The EXIF block sits in the first few hundred KB; read more only if the header is unusually big.
    let size = 512 * 1024
    for (;;) {
      const buf = Buffer.alloc(size)
      const { bytesRead } = await fh.read(buf, 0, size, 0)
      const data = buf.subarray(0, bytesRead)
      if (bytesRead < size || scanJpeg(data)) return orientationOf(data)
      size *= 4
    }
  } finally {
    await fh.close()
  }
}

/** Combines an EXIF orientation with extra clockwise quarter turns (1,6,3,8 = 0/90/180/270; 2,7,4,5 mirrored). */
function rotateOrientation(orientation, quarterTurnsCW) {
  const STATE = { 2: [true, 0], 7: [true, 90], 4: [true, 180], 5: [true, 270], 6: [false, 90], 3: [false, 180], 8: [false, 270] }
  const [mirror, start] = STATE[orientation] ?? [false, 0]
  const angle = (((start + (Math.trunc(quarterTurnsCW) || 0) * 90) % 360) + 360) % 360
  return (mirror ? { 0: 2, 90: 7, 180: 4, 270: 5 } : { 0: 1, 90: 6, 180: 3, 270: 8 })[angle]
}

module.exports = {
  isJpeg,
  writeExif,
  applyExif,
  readOrientation,
  rotateOrientation,
  replaceWithTemp,
  replaceFile,
  sameImageData,
  setSwapJournal,
  recoverSwaps,
  validGps,
  MSG,
}
