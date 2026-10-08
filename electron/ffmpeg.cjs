const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * The bundled ffmpeg (ffmpeg-static): finding it, running it with progress and cancel, reading a
 * video's facts from its banner (ffprobe isn't bundled), and choosing a working H.264 / HEVC
 * encoder — the graphics card's when it has one (NVIDIA → Intel → AMD), else the CPU. It also
 * keeps the list of the video jobs' temporary files, so quitting mid-job doesn't leave them behind.
 */

class FfmpegError extends Error {
  constructor(message, detail = '') {
    super(message)
    this.name = 'FfmpegError'
    /** ffmpeg's own last lines, for logs. */
    this.detail = detail
  }
}

class Canceled extends Error {
  constructor() {
    super('Canceled')
    this.name = 'Canceled'
    this.canceled = true
  }
}

let binary = null
/**
 * Path of ffmpeg.exe. In the packaged app it lives in app.asar.unpacked (a program can't run from
 * inside the asar archive). LUMEN_FFMPEG overrides it.
 */
function ffmpegPath() {
  if (binary) return binary
  let p = process.env.LUMEN_FFMPEG || require('ffmpeg-static')
  if (!p) throw new FfmpegError("Lumen's video tools aren't available on this computer")
  binary = p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  return binary
}

/** ffmpeg's error output → one sentence for people. */
function explain(stderr, fallback = "The video couldn't be processed") {
  const s = String(stderr || '')
  if (/No such file or directory|Error opening input file/i.test(s)) return "The video file can't be found — it may have been moved or deleted"
  if (/No space left on device/i.test(s)) return 'The disk is full'
  if (/Permission denied|Access is denied/i.test(s)) return "Lumen isn't allowed to write in this folder"
  if (/moov atom not found|Invalid data found when processing input|could not find codec parameters/i.test(s))
    return "This file is damaged or isn't a video Lumen can read"
  if (/Error while opening encoder|OpenEncodeSession|No capable devices|nvcuda|Cannot load|DLL .* failed|MFX|amfrt/i.test(s))
    return "The graphics card's video encoder couldn't start"
  if (/Decoder .* not found|Unsupported codec|no decoder/i.test(s)) return "This video uses a format Lumen can't decode"
  return fallback
}

/** The last few meaningful lines of ffmpeg's output (for FfmpegError.detail). */
const tail = (stderr) =>
  String(stderr || '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*(frame|size|time|bitrate|speed)=/.test(l))
    .slice(-6)
    .join('\n')

/**
 * Runs ffmpeg with `args` (after -hide_banner). Options:
 *   duration     seconds of output expected; with onProgress, progress is reported as 0–1
 *   onProgress   (fraction, { time, speed }) while it runs
 *   signal       AbortSignal: kills ffmpeg and rejects with Canceled
 *   stdout       'buffer' collects stdout (e.g. an image piped out); 'stream' leaves it to `onSpawn`
 *   stdin        true keeps stdin open for the caller (raw frames in) — see onSpawn
 *   onSpawn      (child, { poke, hold }) right after starting, e.g. to write to child.stdin. With
 *                stdout 'stream' only the caller sees the output: it calls poke() as output
 *                arrives, and hold() while it keeps the stream paused (ffmpeg waiting for the
 *                reader isn't a hang; the next poke() starts the idle clock again)
 *   idleTimeout  ms without any output before giving up (default 120 s)
 *   allowFail    resolve instead of rejecting on a non-zero exit (probing)
 * Resolves to { code, stderr, stdout?: Buffer }.
 */
function run(args, opts = {}) {
  const { duration, onProgress, signal, stdout = null, stdin = false, onSpawn, idleTimeout = 120_000, allowFail = false } = opts
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Canceled())
    const progress = !!onProgress && !stdout
    const full = ['-hide_banner', ...(stdin ? [] : ['-nostdin']), ...(progress ? ['-progress', 'pipe:1', '-stats_period', '0.25', '-nostats'] : []), ...args]
    let child
    try {
      child = spawn(ffmpegPath(), full, { windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return reject(new FfmpegError("Lumen's video tools couldn't start", String(err?.message || err)))
    }
    let stderr = ''
    const chunks = []
    let canceled = false
    let timedOut = false
    let timer = null
    let held = false // the caller isn't reading the stream for now (see onSpawn)
    const poke = () => {
      clearTimeout(timer)
      timer = null
      if (idleTimeout && !held) {
        timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, idleTimeout)
      }
    }
    const activity = {
      poke: () => {
        held = false
        poke()
      },
      hold: () => {
        held = true
        poke()
      },
    }
    poke()
    const onAbort = () => {
      canceled = true
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr.on('data', (d) => {
      poke()
      stderr += d.toString()
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    if (stdout === 'buffer') {
      child.stdout.on('data', (d) => {
        poke()
        chunks.push(d)
      })
    } else if (progress) {
      let pending = ''
      let speed = 0
      child.stdout.on('data', (d) => {
        poke()
        pending += d.toString()
        const lines = pending.split('\n')
        pending = lines.pop()
        for (const line of lines) {
          const [key, value] = line.trim().split('=')
          if (key === 'speed') speed = parseFloat(value) || 0
          else if (key === 'out_time_us' || key === 'out_time_ms') {
            // both are microseconds (out_time_ms is misnamed in ffmpeg)
            const time = Number(value) / 1e6
            if (Number.isFinite(time) && time >= 0) onProgress(duration ? Math.min(1, time / duration) : 0, { time, speed })
          } else if (key === 'progress' && value === 'end') onProgress(1, { time: duration || 0, speed })
        }
      })
    } else if (stdout !== 'stream') {
      child.stdout.resume()
    }
    if (stdin) child.stdin.on('error', () => {}) // ffmpeg quitting early surfaces as its exit code
    child.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new FfmpegError("Lumen's video tools couldn't start", String(err?.message || err)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (canceled) return reject(new Canceled())
      if (timedOut) return reject(new FfmpegError('The video tools stopped responding', tail(stderr)))
      if (code !== 0 && !allowFail) return reject(new FfmpegError(explain(stderr), tail(stderr)))
      resolve({ code, stderr, stdout: stdout === 'buffer' ? Buffer.concat(chunks) : undefined })
    })
    onSpawn?.(child, activity)
  })
}

// ---------- temporary files ----------

// Work files of video jobs in progress (a memory movie's work folder and its output's .part, a
// video edit's .part). The jobs delete them when they end; cleanupTempsSync() deletes whatever is
// left when the app quits mid-job.
const temps = new Set()

function trackTemp(p) {
  if (p) temps.add(p)
}

function untrackTemp(p) {
  temps.delete(p)
}

/** Deletes every tracked temp file and folder, synchronously (at quit, after the jobs were stopped). */
function cleanupTempsSync() {
  for (const p of temps) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      temps.delete(p)
    } catch {}
  }
}

/**
 * Memory-movie work folders (%TEMP%\lumen-movie-*) left behind by a crash or a forced exit. Only
 * folders older than an hour are removed: never one a movie is being made in.
 */
async function sweepStaleTemps() {
  const dir = os.tmpdir()
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - 60 * 60_000
  await Promise.all(
    names
      .filter((n) => n.startsWith('lumen-movie-'))
      .map(async (n) => {
        const p = path.join(dir, n)
        if (temps.has(p)) return
        try {
          const st = await fsp.stat(p)
          if (st.isDirectory() && st.mtimeMs < cutoff) await fsp.rm(p, { recursive: true, force: true })
        } catch {}
      }),
  )
}

// ---------- probing ----------

const num = (v) => (v == null || v === '' ? NaN : Number(v))
const seconds = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s)

/**
 * Reads what ffmpeg prints about a file. Resolves to
 * { duration, start, bitrate (bit/s), format, metadata, video, audio } where
 *   video = { codec, profile, pixFmt, tenBit, width, height (as stored), displayWidth, displayHeight
 *             (upright), rotation (clockwise degrees to show it upright), fps, bitrate, colorTransfer,
 *             colorPrimaries, colorSpace, hdr: 'hlg' | 'pq' | null }  (null for audio-only files)
 *   audio = { codec, sampleRate, channels, bitrate } | null
 * Rejects when the file can't be read as media.
 */
async function probe(file, { signal } = {}) {
  const { stderr } = await run(['-i', file], { signal, allowFail: true, idleTimeout: 30_000 })
  const info = parseProbe(stderr)
  if (!info) throw new FfmpegError(explain(stderr, "This file isn't a video Lumen can read"), tail(stderr))
  return info
}

function parseProbe(text) {
  const lines = String(text).split(/\r?\n/)
  const start = lines.findIndex((l) => /^Input #0,/.test(l))
  if (start < 0) return null
  const out = { duration: 0, start: 0, bitrate: 0, format: '', metadata: {}, video: null, audio: null }
  out.format = (/^Input #0, ([^ ]+), from/.exec(lines[start]) || [])[1] || ''
  let section = 'global' // which "Metadata:" block we are in
  let current = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^Input #1|^Output #|^At least one output/.test(line)) break
    let m
    if ((m = /^\s+Duration: (?:(\d+):(\d+):([\d.]+)|N\/A)(?:, start: (-?[\d.]+))?(?:, bitrate: (\d+) kb\/s)?/.exec(line))) {
      if (m[1] !== undefined) out.duration = seconds(m[1], m[2], m[3])
      out.start = num(m[4]) || 0
      out.bitrate = (num(m[5]) || 0) * 1000
      section = 'none'
      continue
    }
    if ((m = /^\s+Stream #0:(\d+)[^:]*: (Video|Audio|Data|Subtitle|Attachment): (.*)$/.exec(line))) {
      current = null
      section = 'stream'
      const kind = m[2]
      const desc = m[3]
      if (kind === 'Video' && !out.video && !/attached pic/.test(desc)) {
        current = out.video = parseVideo(desc)
      } else if (kind === 'Audio' && !out.audio) {
        current = out.audio = parseAudio(desc)
      }
      continue
    }
    if (/^\s+Metadata:\s*$/.test(line)) continue
    if ((m = /^\s+displaymatrix: rotation of (-?[\d.]+) degrees/.exec(line)) && current && current === out.video) {
      // ffmpeg reports the counter-clockwise angle; people think clockwise
      current.matrixRotation = Number(m[1])
      current.rotation = ((Math.round(-Number(m[1]) / 90) * 90) % 360 + 360) % 360
      continue
    }
    if ((m = /^(\s+)([^:]+?)\s*: (.*)$/.exec(line))) {
      const depth = m[1].length
      if (section === 'global' && depth <= 4) out.metadata[m[2]] = m[3]
      else if (current && depth >= 6 && m[2] === 'rotate' && current === out.video && current.rotation == null) {
        current.rotation = ((Number(m[3]) % 360) + 360) % 360
      }
    }
  }
  const v = out.video
  if (v) {
    v.rotation ??= 0
    v.matrixRotation ??= 0
    const sideways = v.rotation === 90 || v.rotation === 270
    v.displayWidth = sideways ? v.height : v.width
    v.displayHeight = sideways ? v.width : v.height
  }
  return out
}

function parseVideo(desc) {
  const codec = (/^(\w+)/.exec(desc) || [])[1] || ''
  const profile = (/^\w+ \(([^)]*)\)/.exec(desc) || [])[1] || ''
  // pixel format, optionally followed by "(tv, bt2020nc/bt2020/arib-std-b67, progressive)"
  const pix = /, ((?:yuv|yuvj|nv|p0|gbr|rgb|bgr|gray|pal)\w*)(?:\(([^)]*)\))?/.exec(desc)
  const pixFmt = pix?.[1] || ''
  const color = pix?.[2] || ''
  let colorSpace = ''
  let colorPrimaries = ''
  let colorTransfer = ''
  const tri = /(\w[\w-]*)\/(\w[\w-]*)\/(\w[\w-]*)/.exec(color)
  if (tri) [, colorSpace, colorPrimaries, colorTransfer] = tri
  else {
    const one = color.split(',').map((s) => s.trim())
    if (/^bt|^smpte|^fcc|^ycgco/.test(one[1] || '')) colorSpace = colorPrimaries = colorTransfer = one[1]
  }
  const size = /, (\d{2,5})x(\d{2,5})/.exec(desc)
  // The frame rate, else the guessed one (tbr). Variable-rate WebM / MKV often show only "1k tbr"
  // (the container's millisecond clock, not a frame rate): 1000 or more counts as unknown (0).
  const rate = (m) => (m ? Number(m[1]) * (m[2] ? 1000 : 1) : 0)
  const fps = [rate(/, ([\d.]+)(k?) fps/.exec(desc)), rate(/, ([\d.]+)(k?) tbr/.exec(desc))].find((v) => v > 0 && v < 1000) ?? 0
  const bitrate = /, (\d+) kb\/s/.exec(desc)
  const hdr = colorTransfer === 'arib-std-b67' ? 'hlg' : colorTransfer === 'smpte2084' ? 'pq' : null
  return {
    codec,
    profile,
    pixFmt,
    tenBit: /10|12/.test(pixFmt),
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    fps,
    bitrate: bitrate ? Number(bitrate[1]) * 1000 : 0,
    colorSpace,
    colorPrimaries,
    colorTransfer,
    hdr,
    rotation: null,
    matrixRotation: null,
  }
}

function parseAudio(desc) {
  const codec = (/^(\w+)/.exec(desc) || [])[1] || ''
  const rate = /, (\d+) Hz/.exec(desc)
  const layout = /Hz, ([^,]+)/.exec(desc)?.[1]?.trim() || ''
  const channels = /mono/.test(layout) ? 1 : /stereo/.test(layout) ? 2 : Number((/(\d+)\.(\d)/.exec(layout) || [])[1]) + 1 || Number((/(\d+) channels/.exec(layout) || [])[1]) || 2
  const bitrate = /, (\d+) kb\/s/.exec(desc)
  return { codec, sampleRate: rate ? Number(rate[1]) : 0, channels, bitrate: bitrate ? Number(bitrate[1]) * 1000 : 0 }
}

// ---------- encoders ----------

const H264 = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']
const HEVC = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'libx265']
const HARDWARE = new Set(['h264_nvenc', 'h264_qsv', 'h264_amf', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf'])
let detected = null

/** A tiny test encode: does this encoder actually start on this computer? */
async function works(encoder, tenBit = false) {
  const pix = tenBit ? 'p010le' : encoder.endsWith('_qsv') ? 'nv12' : 'yuv420p'
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30', '-frames:v', '3', '-pix_fmt', pix, '-c:v', encoder]
  if (tenBit) args.push('-profile:v', 'main10')
  args.push('-f', 'null', '-')
  try {
    await run(args, { idleTimeout: 20_000 })
    return true
  } catch {
    return false
  }
}

/**
 * The encoders that work here, best first: { h264: [...], hevc: [...], hevc10: [...] }. The
 * graphics card's are tested once per session (a fraction of a second each, in parallel); the
 * CPU ones (libx264 / libx265) always work and come last. LUMEN_VIDEO_ENCODER=libx264 (for tests)
 * forces the CPU.
 */
function encoders() {
  detected ??= (async () => {
    if (/^lib/.test(process.env.LUMEN_VIDEO_ENCODER || '')) return { h264: ['libx264'], hevc: ['libx265'], hevc10: ['libx265'] }
    const hw = [...H264, ...HEVC].filter((e) => HARDWARE.has(e))
    const ok = await Promise.all(hw.map((e) => works(e)))
    const good = new Set(hw.filter((_, i) => ok[i]))
    const hevc10 = await Promise.all(HEVC.filter((e) => good.has(e)).map(async (e) => ((await works(e, true)) ? e : null)))
    return {
      h264: H264.filter((e) => good.has(e) || !HARDWARE.has(e)),
      hevc: HEVC.filter((e) => good.has(e) || !HARDWARE.has(e)),
      hevc10: [...hevc10.filter(Boolean), 'libx265'],
    }
  })()
  return detected
}

/**
 * Encoder options aiming at `bitrate` (bit/s): VBR on the graphics card, constant quality capped
 * at about that rate on the CPU. `tenBit` keeps 10-bit colour (HDR HEVC from phones); `input`
 * 'nv12' (raw frames already in the graphics cards' own layout) skips a conversion.
 */
function encoderArgs(encoder, { bitrate, tenBit = false, gop = 0, fast = false, input = '' }) {
  const b = Math.max(500_000, Math.round(bitrate))
  const rate = ['-b:v', String(b), '-maxrate', String(Math.round(b * 1.5)), '-bufsize', String(b * 2)]
  const hevc = encoder.startsWith('hevc') || encoder === 'libx265'
  const args = ['-c:v', encoder]
  if (encoder.endsWith('_nvenc')) {
    args.push('-preset', fast ? 'p3' : 'p5', '-tune', 'hq', '-rc', 'vbr', ...rate, '-spatial-aq', '1')
    args.push('-pix_fmt', tenBit ? 'p010le' : input === 'nv12' ? 'nv12' : 'yuv420p')
    args.push('-profile:v', hevc ? (tenBit ? 'main10' : 'main') : 'high')
  } else if (encoder.endsWith('_qsv')) {
    args.push('-preset', fast ? 'faster' : 'medium', ...rate, '-pix_fmt', tenBit ? 'p010le' : 'nv12')
    if (hevc && tenBit) args.push('-profile:v', 'main10')
  } else if (encoder.endsWith('_amf')) {
    args.push('-quality', fast ? 'speed' : 'balanced', '-rc', 'vbr_peak', ...rate, '-pix_fmt', tenBit ? 'p010le' : 'nv12')
    if (!hevc) args.push('-profile:v', 'high')
  } else if (encoder === 'libx265') {
    const kb = Math.round(b / 1000)
    args.push('-preset', 'faster', '-crf', '20', '-x265-params', `vbv-maxrate=${Math.round(kb * 1.5)}:vbv-bufsize=${kb * 2}:log-level=error`)
    args.push('-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p')
  } else {
    args.push('-preset', fast ? 'veryfast' : 'faster', '-crf', '18', '-maxrate', String(Math.round(b * 1.5)), '-bufsize', String(b * 2))
    args.push('-pix_fmt', 'yuv420p', '-profile:v', 'high')
  }
  if (gop) args.push('-g', String(gop))
  if (hevc) args.push('-tag:v', 'hvc1') // the tag Apple devices and browsers expect
  return args
}

/** HDR (HLG / PQ) → ordinary colours, for stills and movie clips. */
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv'

module.exports = {
  ffmpegPath,
  run,
  probe,
  parseProbe,
  encoders,
  encoderArgs,
  explain,
  FfmpegError,
  Canceled,
  TONEMAP,
  HARDWARE,
  trackTemp,
  untrackTemp,
  cleanupTempsSync,
  sweepStaleTemps,
}
