const fsp = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')
const { run, probe, encoders, encoderArgs, FfmpegError, Canceled, TONEMAP, trackTemp, untrackTemp } = require('./ffmpeg.cjs')
const { renameRetry } = require('./safe-file.cjs')

/**
 * Video edits, always saved as a new file next to the original (the original is never changed).
 *
 * A recipe:
 *   start, end   seconds to keep
 *   exact        false: "quick" — no re-encoding (full quality, seconds to save), but the cut can
 *                only start on a keyframe, so it starts at the keyframe at or before `start`
 *                (phones put one every 1–2 s). true: re-encode, cutting on the exact frame.
 *   mute         drop the sound
 *   rotate       clockwise turn 0 / 90 / 180 / 270 — lossless for MP4/MOV (only the "display
 *                rotation" tag changes), else part of a re-encode
 *   speed        0.5 / 1 / 2 / 4 — anything but 1 re-encodes
 * The copy keeps the original's metadata (creation date, place, camera), and its file date.
 */

const SPEEDS = [0.5, 1, 2, 4]
/** Containers whose streams can be cut without re-encoding: extension → ffmpeg muxer. */
const COPY_FORMATS = {
  mp4: 'mp4',
  m4v: 'mp4',
  mov: 'mov',
  '3gp': '3gp',
  mkv: 'matroska',
  webm: 'webm',
  avi: 'avi',
  mts: 'mpegts',
  m2ts: 'mpegts',
  wmv: 'asf',
  mpg: 'mpeg',
  mpeg: 'mpeg',
}
/** These also store a display rotation, so turning is lossless. */
const MP4_FAMILY = new Set(['mp4', 'm4v', 'mov', '3gp'])

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0))

/**
 * Times (s) of the video's keyframes, read from the packet list (no decoding: a 4K clip of
 * 170 MB takes about 0.3 s).
 */
async function keyframes(file, { signal } = {}) {
  const { stdout } = await run(['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'], {
    signal,
    stdout: 'buffer',
    idleTimeout: 60_000,
  })
  const text = stdout.toString('latin1')
  const tb = /#tb 0: (\d+)\/(\d+)/.exec(text)
  const scale = tb ? Number(tb[1]) / Number(tb[2]) : 1 / 1000
  const out = []
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#' || line.includes('F=0x')) continue // F=0x… marks a non-keyframe
    const pts = Number(line.split(',')[2])
    if (Number.isFinite(pts)) out.push(pts * scale)
  }
  return [...new Set(out.map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b)
}

/**
 * What the editor needs: probe facts plus keyframes and what can be done without re-encoding.
 * { duration, width, height (as shown, upright), rotation, fps, codec, hdr, tenBit, hasAudio,
 *   bitrate, keyframes, lossless: { trim, rotate } }
 */
async function videoInfo(file, { signal } = {}) {
  const ext = path.extname(file).slice(1).toLowerCase()
  const [p, keys] = await Promise.all([probe(file, { signal }), keyframes(file, { signal }).catch(() => [])])
  if (!p.video) throw new FfmpegError("This file has no picture Lumen can edit")
  encoders().catch(() => {}) // warm up the encoder check while the person edits
  return {
    duration: p.duration,
    width: p.video.displayWidth,
    height: p.video.displayHeight,
    rotation: p.video.rotation,
    fps: p.video.fps,
    codec: p.video.codec,
    hdr: p.video.hdr,
    tenBit: p.video.tenBit,
    hasAudio: !!p.audio,
    bitrate: p.bitrate,
    keyframes: keys,
    lossless: { trim: !!COPY_FORMATS[ext] && keys.length > 0, rotate: MP4_FAMILY.has(ext) },
  }
}

function cleanRecipe(r = {}, duration = Infinity) {
  const dur = Number.isFinite(duration) && duration > 0 ? duration : Infinity
  const start = clamp(r.start, 0, Number.isFinite(dur) ? dur : 1e9)
  let end = r.end == null || !Number.isFinite(Number(r.end)) ? dur : clamp(r.end, 0, Number.isFinite(dur) ? dur : 1e9)
  if (end <= start) end = Math.min(dur, start + 0.1)
  const speed = SPEEDS.includes(Number(r.speed)) ? Number(r.speed) : 1
  return {
    start,
    end,
    exact: !!r.exact,
    mute: !!r.mute,
    rotate: ((Math.round((Number(r.rotate) || 0) / 90) * 90) % 360 + 360) % 360,
    speed,
  }
}

/** The keyframe at or before `t` (where a quick cut really starts). */
function keyframeBefore(keys, t) {
  let best = 0
  for (const k of keys) {
    if (k <= t + 1e-3) best = k
    else break
  }
  return best
}

const isIdentity = (r, duration) => r.start < 0.05 && r.end > duration - 0.05 && !r.mute && !r.rotate && r.speed === 1

async function freeName(dir, base, suffix, ext) {
  for (let n = 1; n < 1000; n++) {
    const name = `${base} (${suffix}${n > 1 ? ` ${n}` : ''}).${ext}`
    try {
      await fsp.access(path.join(dir, name))
    } catch {
      return path.join(dir, name)
    }
  }
  throw new Error('No free file name')
}

/** Seconds as ffmpeg reads them, rounded up to the microsecond (so a keyframe isn't missed). */
const ts = (s) => (Math.ceil(s * 1e6) / 1e6).toFixed(6)

/** atempo takes 0.5–2 per step. */
function atempo(speed) {
  const steps = []
  let s = speed
  while (s > 2) {
    steps.push(2)
    s /= 2
  }
  while (s < 0.5) {
    steps.push(0.5)
    s /= 0.5
  }
  steps.push(s)
  return steps.map((x) => `atempo=${x}`).join(',')
}

/** A bitrate that keeps about the original's quality. */
function targetBitrate(p, { toH264 = false, fps = 0 } = {}) {
  const v = p.video
  let b = v.bitrate || Math.max(0, p.bitrate - (p.audio?.bitrate || 0))
  if (!b) b = v.width * v.height * (v.fps || 30) * 0.12 // a typical H.264 rate
  if (toH264 && v.codec === 'hevc') b *= 1.5 // H.264 needs more bits for the same look
  if (fps && v.fps && fps > v.fps) b *= fps / v.fps
  return clamp(b, 1_000_000, 150_000_000)
}

/**
 * Saves the edited copy next to the original. `item` is a library item ({ path, dir, name, mtime }).
 * Resolves to { file, mode: 'copy' | 'encode', encoder, start, end, seconds }.
 * Rejects with FfmpegError (plain message) or Canceled.
 */
async function saveEdit(item, recipe, { onProgress, signal } = {}) {
  const t0 = Date.now()
  const p = await probe(item.path, { signal })
  if (!p.video) throw new FfmpegError("This file has no picture Lumen can edit")
  const r = cleanRecipe(recipe, p.duration)
  if (isIdentity(r, p.duration)) throw new FfmpegError('Nothing to save — no changes yet')
  const ext = path.extname(item.path).slice(1).toLowerCase()
  const base = path.basename(item.name || item.path, path.extname(item.name || item.path))
  const dir = item.dir || path.dirname(item.path)

  // quick (stream copy) when nothing needs new pictures
  let copy = !r.exact && r.speed === 1 && !!COPY_FORMATS[ext] && (!r.rotate || MP4_FAMILY.has(ext))
  let start = r.start
  let seekAt = r.start // what ffmpeg is asked to seek to
  if (copy) {
    const keys = await keyframes(item.path, { signal }).catch(() => [])
    if (!keys.length) copy = false
    else {
      seekAt = start = keyframeBefore(keys, r.start)
      if (!MP4_FAMILY.has(ext) && start > 0) {
        // MKV, AVI, TS… seek by decode time and ffmpeg aims 0.13 s early there (B-frames), which
        // would land on the keyframe before; aim a little after this one instead. The frames in
        // between are kept, so the copy still starts at the keyframe.
        const next = keys.find((k) => k > start + 1e-3) ?? Infinity
        seekAt = start + Math.min(0.2, (next - start) / 2)
      }
    }
  }
  const outExt = copy ? ext : ext === 'mov' ? 'mov' : ext === 'm4v' ? 'm4v' : 'mp4'
  const muxer = copy ? COPY_FORMATS[ext] : outExt === 'mov' ? 'mov' : 'mp4'
  const file = await freeName(dir, base, 'edited', outExt)
  const part = `${file}.part`
  const span = Math.max(0.05, r.end - start)
  const outDuration = span / r.speed

  const input = []
  if (r.rotate) {
    // ffmpeg's display rotation is counter-clockwise; it replaces the stored one, so add them up
    let ccw = (p.video.matrixRotation || 0) - r.rotate
    ccw = ((ccw % 360) + 540) % 360 - 180
    input.push('-display_rotation:v:0', String(ccw))
  }
  if (seekAt > 0) input.push('-ss', ts(seekAt))
  input.push('-t', ts(Math.max(0.05, r.end - seekAt)), '-i', item.path)
  const meta = ['-map_metadata', '0']
  if (MP4_FAMILY.has(outExt)) meta.push('-movflags', 'use_metadata_tags') // keeps phones' place / camera keys
  const maps = ['-map', '0:v:0']
  if (!r.mute && p.audio) maps.push('-map', copy ? '0:a?' : '0:a:0')
  else maps.push('-an')

  const finish = async (mode, encoder) => {
    await renameRetry(part, file) // (antivirus may still be reading the new file)
    // the copy sits next to the original in date order (file date as well as metadata)
    const st = await fsp.stat(item.path).catch(() => null)
    const mtime = st ? st.mtime : new Date(item.mtime || Date.now())
    await fsp.utimes(file, new Date(), mtime).catch(() => {})
    return { file, mode, encoder, start, end: start + span, seconds: (Date.now() - t0) / 1000 }
  }
  const progress = (f) => onProgress?.(f)

  trackTemp(part) // deleted at quit if the app closes mid-save
  try {
    if (copy) {
      await run([...input, ...maps, '-c', 'copy', ...meta, '-f', muxer, '-y', part], { duration: outDuration, onProgress: progress, signal })
      return await finish('copy', 'copy')
    }

    // re-encode: same family as the original (HEVC stays HEVC, 10-bit HDR stays 10-bit)
    const enc = await encoders()
    const v = p.video
    let list
    let tenBit = false
    if (v.codec === 'hevc' && v.tenBit) {
      list = enc.hevc10
      tenBit = true
    } else if (v.codec === 'hevc' && enc.hevc[0] !== 'libx265') list = enc.hevc
    else list = enc.h264
    const srcFps = v.fps || 30
    const fps = r.speed === 1 ? 0 : Math.min(srcFps, Math.max(srcFps * r.speed, Math.min(30, srcFps)))
    const filters = []
    if (r.speed !== 1) filters.push(`setpts=PTS/${r.speed}`, `fps=${+fps.toFixed(3)}`)
    const color = []
    if (tenBit && v.colorPrimaries) color.push('-color_primaries', v.colorPrimaries)
    if (tenBit && v.colorTransfer) color.push('-color_trc', v.colorTransfer)
    if (tenBit && v.colorSpace) color.push('-colorspace', v.colorSpace)
    const audio = []
    if (!r.mute && p.audio) {
      if (r.speed === 1 && p.audio.codec === 'aac') audio.push('-c:a', 'copy')
      else audio.push('-c:a', 'aac', '-b:a', String(clamp(p.audio.bitrate || 192_000, 128_000, 320_000)))
      if (r.speed !== 1) audio.push('-filter:a', atempo(r.speed))
    }
    let lastError = null
    for (const encoder of list) {
      const toH264 = !encoder.startsWith('hevc') && encoder !== 'libx265'
      const bitrate = targetBitrate(p, { toH264, fps })
      const args = [
        ...input,
        ...maps,
        ...(filters.length ? ['-filter:v', filters.join(',')] : []),
        ...encoderArgs(encoder, { bitrate, tenBit: tenBit && !toH264, gop: Math.round((fps || srcFps) * 2) }),
        ...color,
        ...audio,
        ...meta,
        '-f',
        muxer,
        '-y',
        part,
      ]
      let started = false
      try {
        await run(args, {
          duration: outDuration,
          signal,
          onProgress: (f, s) => {
            if (s.time > 0) started = true
            progress(f)
          },
        })
        return await finish('encode', encoder)
      } catch (err) {
        if (err instanceof Canceled || started) throw err
        lastError = err // the graphics card's encoder didn't start: try the next one
      }
    }
    throw lastError || new FfmpegError("The video couldn't be saved")
  } catch (err) {
    await fsp.rm(part, { force: true }).catch(() => {})
    throw err
  } finally {
    untrackTemp(part)
  }
}

// ---------- still frames ----------

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

/** Camera and place from the video's own metadata (phones write these). */
function videoFacts(metadata = {}) {
  const pick = (...keys) => keys.map((k) => metadata[k]).find((v) => v && String(v).trim())
  const make = pick('com.apple.quicktime.make', 'make', 'com.android.manufacturer')
  const model = pick('com.apple.quicktime.model', 'model', 'com.android.model')
  const loc = pick('com.apple.quicktime.location.ISO6709', 'location', 'location-eng')
  const m = loc && /([+-]\d{1,2}\.\d+)([+-]\d{1,3}\.\d+)/.exec(loc)
  return { make, model, lat: m ? Number(m[1]) : undefined, lon: m ? Number(m[2]) : undefined }
}

/** "0m12s", "1m05s" */
const frameLabel = (s) => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`

/**
 * Saves the frame shown at `seconds` as a full-resolution JPEG next to the video, dated the video's
 * date plus that offset, with the video's camera and place. `item.date` is the video's capture
 * time (ms). Resolves to { file }.
 */
async function saveFrame(item, seconds, { signal } = {}) {
  const p = await probe(item.path, { signal })
  if (!p.video) throw new FfmpegError("This file has no picture Lumen can save")
  const fps = p.video.fps || 30
  const t = clamp(seconds, 0, Math.max(0, p.duration - 0.5 / fps))
  // the player shows the frame whose time is at or just before `t`
  const at = Math.max(0, t - 0.95 / fps)
  const vf = [p.video.hdr ? TONEMAP : null, 'format=rgb24'].filter(Boolean).join(',')
  const { stdout } = await run(['-v', 'error', '-ss', ts(at), '-i', item.path, '-frames:v', '1', '-an', '-vf', vf, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], {
    signal,
    stdout: 'buffer',
    idleTimeout: 60_000,
  })
  if (!stdout?.length) throw new FfmpegError("That frame couldn't be read")
  const facts = videoFacts(p.metadata)
  const when = (Number(item.date) || Date.now()) + t * 1000
  const ifd0 = { Software: 'Lumen', ImageDescription: `Frame from ${item.name || path.basename(item.path)}` }
  if (facts.make || item.meta?.make) ifd0.Make = facts.make || item.meta.make
  if (facts.model || item.meta?.model) ifd0.Model = facts.model || item.meta.model
  const exif = {
    IFD0: ifd0,
    IFD2: { DateTimeOriginal: exifDate(when), DateTimeDigitized: exifDate(when), SubSecTimeOriginal: String(Math.floor(when % 1000)).padStart(3, '0') },
  }
  const lat = Number.isFinite(item.meta?.lat) ? item.meta.lat : facts.lat
  const lon = Number.isFinite(item.meta?.lon) ? item.meta.lon : facts.lon
  if (Number.isFinite(lat) && Number.isFinite(lon)) exif.IFD3 = gpsTags(lat, lon)
  const base = path.basename(item.name || item.path, path.extname(item.name || item.path))
  const file = await freeName(item.dir || path.dirname(item.path), base, `frame ${frameLabel(t)}`, 'jpg')
  if (signal?.aborted) throw new Canceled()
  await sharp(stdout).withExif(exif).jpeg({ quality: 92, mozjpeg: true }).toFile(file)
  await fsp.utimes(file, new Date(), new Date(when)).catch(() => {})
  return { file, time: t, date: when }
}

module.exports = { videoInfo, keyframes, saveEdit, saveFrame, cleanRecipe, keyframeBefore, videoFacts, COPY_FORMATS }
