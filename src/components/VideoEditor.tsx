import { Check, ImageDown, LoaderCircle, Pause, Play, RotateCcw, RotateCw, Undo2, VolumeX, X } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { mediaUrl, thumbUrl } from '../api'
import { useElementSize } from '../hooks'
import { formatLongDate, formatTime } from '../lib/format'
import type { MediaItem } from '../types'
import './video-editor.css'

/** A video edit (see electron/video-edit.cjs). */
export interface VideoRecipe {
  /** Seconds to keep. */
  start: number
  end: number
  /** false: quick, no re-encoding (starts at the keyframe at or before `start`); true: frame-exact. */
  exact: boolean
  mute: boolean
  /** Clockwise. */
  rotate: 0 | 90 | 180 | 270
  /** 0.5, 1, 2 or 4. */
  speed: number
}

/** What main tells the editor about the video (video-edit.cjs videoInfo). */
export interface VideoInfo {
  duration: number
  /** As shown (upright). */
  width: number
  height: number
  rotation: number
  fps: number
  codec: string
  hdr: 'hlg' | 'pq' | null
  tenBit: boolean
  hasAudio: boolean
  bitrate: number
  /** Keyframe times (s). */
  keyframes: number[]
  /** What can be saved without re-encoding. */
  lossless: { trim: boolean; rotate: boolean }
}

interface Props {
  item: MediaItem
  /** From main; null while it loads (the editor works without it, minus keyframe hints). */
  info: VideoInfo | null
  /** 0–1 while a copy is being saved. */
  progress: number | null
  /** Saves the copy; resolves when done (the caller closes the editor or shows the error). */
  onSave(recipe: VideoRecipe): Promise<void>
  /** Saves the frame at `seconds` as a photo. */
  onSaveFrame(seconds: number): Promise<void>
  /** Stops a save that is running. */
  onAbort(): void
  onClose(): void
}

const SPEEDS = [0.5, 1, 2, 4]
const MIN_LENGTH = 0.3
const STRIP_H = 52

/** 0:04.2, 1:02:03.5 */
export function clockTenths(seconds: number) {
  const t = Math.max(0, Math.round(seconds * 10) / 10)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = (t % 60).toFixed(1).padStart(4, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Where a quick cut really starts: the keyframe at or before `t`. */
export function keyframeBefore(keys: number[], t: number) {
  let best = 0
  for (const k of keys) {
    if (k <= t + 1e-3) best = k
    else break
  }
  return best
}

const once = (el: HTMLElement, event: string) =>
  new Promise<void>((resolve, reject) => {
    const ok = () => {
      el.removeEventListener('error', bad)
      resolve()
    }
    const bad = () => {
      el.removeEventListener(event, ok)
      reject(new Error('video'))
    }
    el.addEventListener(event, ok, { once: true })
    el.addEventListener('error', bad, { once: true })
  })

export function VideoEditor({ item, info, progress, onSave, onSaveFrame, onAbort, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLCanvasElement>(null)
  const player = useElementSize(playerRef)
  const line = useElementSize(lineRef)
  const [duration, setDuration] = useState(info?.duration || item.duration || 0)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState<number | null>(null) // null: to the end
  const [exact, setExact] = useState(false)
  const [mute, setMute] = useState(false)
  const [rotate, setRotate] = useState<VideoRecipe['rotate']>(0)
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState<'save' | 'frame' | null>(null)
  const [failed, setFailed] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  useEffect(() => {
    if (info?.duration && !duration) setDuration(info.duration)
  }, [info?.duration])

  const fps = info?.fps || 30
  const endAt = end ?? duration
  const trimmed = start > 0.05 || (duration > 0 && endAt < duration - 0.05)
  const changed = trimmed || mute || rotate !== 0 || speed !== 1
  // re-encoding is needed for speed, for turning files that can't store a turn, or when the
  // container can't be cut losslessly
  const encodeReason =
    speed !== 1
      ? 'Changing the speed re-encodes the video.'
      : rotate && info && !info.lossless.rotate
        ? 'Turning this kind of file re-encodes it.'
        : info && !info.lossless.trim && trimmed
          ? "This kind of file can't be cut without re-encoding."
          : null
  const quick = !exact && !encodeReason
  const keys = info?.keyframes ?? []
  const quickStart = quick && trimmed && keys.length ? keyframeBefore(keys, start) : start
  const playFrom = quickStart
  const saving = busy === 'save'

  // ---------- playback ----------
  const seek = (t: number) => {
    const v = videoRef.current
    const to = Math.max(0, Math.min(duration || 0, t))
    if (v) v.currentTime = to
    setTime(to)
  }
  const play = () => {
    const v = videoRef.current
    if (!v) return
    if (v.currentTime >= endAt - 0.05 || v.currentTime < playFrom - 0.01) v.currentTime = playFrom
    v.play().catch(() => {})
  }
  const pause = () => videoRef.current?.pause()
  const toggle = () => (videoRef.current?.paused ? play() : pause())
  const step = (frames: number) => {
    pause()
    seek((videoRef.current?.currentTime ?? time) + frames / fps)
  }

  // a smooth playhead while playing; stop at the end of the part kept
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const v = videoRef.current
      if (v) {
        if (v.currentTime >= endAt) {
          v.pause()
          v.currentTime = endAt
        }
        setTime(v.currentTime)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, endAt])

  useEffect(() => {
    const v = videoRef.current
    if (v) v.playbackRate = speed
  }, [speed])
  useEffect(() => {
    const v = videoRef.current
    if (v) v.muted = mute
  }, [mute])
  useEffect(() => () => videoRef.current?.pause(), [])

  // ---------- frame strip (pictures along the timeline, read by a hidden player) ----------
  const stripWidth = Math.round(line.width / 40) * 40 // redraw only on real size changes
  useEffect(() => {
    const canvas = stripRef.current
    if (!canvas || !duration || failed || !stripWidth) return
    let cancelled = false
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.src = mediaUrl(item)
    ;(async () => {
      try {
        await once(v, 'loadeddata')
        const ctx = canvas.getContext('2d')
        if (!ctx || cancelled) return
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.round(stripWidth * dpr)
        canvas.height = Math.round(STRIP_H * dpr)
        const tile = Math.max(24, Math.round(STRIP_H * (v.videoWidth / Math.max(1, v.videoHeight))))
        const n = Math.max(1, Math.ceil(stripWidth / tile))
        for (let i = 0; i < n && !cancelled; i++) {
          v.currentTime = Math.min(duration - 0.05, ((i + 0.5) * duration) / n)
          await once(v, 'seeked')
          if (cancelled) break
          ctx.drawImage(v, Math.round(i * tile * dpr), 0, Math.round(tile * dpr), canvas.height)
        }
      } catch {
        // no strip: the timeline still works
      }
    })()
    return () => {
      cancelled = true
      v.removeAttribute('src')
      v.load()
    }
  }, [item.id, duration > 0, stripWidth, failed])

  // ---------- timeline dragging ----------
  const drag = useRef<'start' | 'end' | 'seek' | null>(null)
  const timeAt = (clientX: number) => {
    const r = lineRef.current?.getBoundingClientRect()
    if (!r || !duration) return 0
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration))
  }
  const onDown = (what: 'start' | 'end' | 'seek') => (e: ReactPointerEvent) => {
    if (saving || !duration) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = what
    pause()
    if (what === 'seek') seek(timeAt(e.clientX))
  }
  const onMove = (e: ReactPointerEvent) => {
    const what = drag.current
    if (!what) return
    const t = timeAt(e.clientX)
    if (what === 'seek') seek(t)
    else if (what === 'start') {
      const s = Math.min(t, endAt - MIN_LENGTH)
      setStart(Math.max(0, s))
      seek(Math.max(0, s))
    } else {
      const en = Math.max(t, start + MIN_LENGTH)
      setEnd(en >= duration - 0.02 ? null : en)
      seek(en)
    }
  }
  const onUp = () => (drag.current = null)

  const setStartHere = () => {
    const t = videoRef.current?.currentTime ?? time
    if (t < endAt - MIN_LENGTH) setStart(t)
  }
  const setEndHere = () => {
    const t = videoRef.current?.currentTime ?? time
    if (t > start + MIN_LENGTH) setEnd(t >= duration - 0.02 ? null : t)
  }

  // ---------- saving / closing ----------
  const reset = () => {
    setStart(0)
    setEnd(null)
    setExact(false)
    setMute(false)
    setRotate(0)
    setSpeed(1)
  }
  const save = async () => {
    if (!changed || busy) return
    pause()
    setBusy('save')
    try {
      await onSave({ start, end: endAt, exact: !quick, mute, rotate, speed })
    } finally {
      setBusy(null)
    }
  }
  const saveFrame = async () => {
    if (busy) return
    pause()
    setBusy('frame')
    try {
      await onSaveFrame(videoRef.current?.currentTime ?? time)
    } finally {
      setBusy(null)
    }
  }
  const close = () => {
    if (saving) return
    if (changed) setConfirmClose(true)
    else onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input[type="text"], textarea')) return
      e.stopPropagation()
      const key = e.key
      const mod = e.ctrlKey || e.metaKey
      if (key === 'Escape') {
        e.preventDefault()
        if (confirmClose) setConfirmClose(false)
        else close()
      } else if (mod && key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      } else if (mod && key.toLowerCase() === 'z') {
        e.preventDefault()
        reset()
      } else if (busy || confirmClose) {
        return
      } else if (key === ' ' || key === 'k') {
        e.preventDefault()
        toggle()
      } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault()
        const dir = key === 'ArrowLeft' ? -1 : 1
        if (e.shiftKey) seek(time + dir)
        else step(dir)
      } else if (key === 'i' || key === '[') setStartHere()
      else if (key === 'o' || key === ']') setEndHere()
      else if (key === 'Home') seek(playFrom)
      else if (key === 'End') seek(endAt)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // ---------- layout ----------
  const turned = rotate % 180 !== 0
  const vw = dims?.w || info?.width || 16
  const vh = dims?.h || info?.height || 9
  const aspect = turned ? vh / vw : vw / vh
  const boxW = Math.max(1, Math.min(player.width - 48, (player.height - 48) * aspect))
  const boxH = Math.max(1, boxW / aspect)
  const videoStyle = {
    width: turned ? boxH : boxW,
    height: turned ? boxW : boxH,
    transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
  }
  const pct = (t: number) => `${duration ? (Math.max(0, Math.min(duration, t)) / duration) * 100 : 0}%`
  const lengthOut = Math.max(0, endAt - (quick ? quickStart : start)) / speed
  const frameDate = item.date + time * 1000

  const section = (title: string, children: ReactNode) => (
    <section className="edit-section">
      <h4>{title}</h4>
      {children}
    </section>
  )

  let trimHint: string
  if (encodeReason) trimHint = `${encodeReason} Cuts are frame-exact; it takes a little longer.`
  else if (!quick) trimHint = 'Cuts on the exact frame. The video is re-encoded on your graphics card, which takes longer.'
  else if (!trimmed) trimHint = 'Keeps full quality and saves in seconds.'
  else if (!keys.length) trimHint = 'Keeps full quality and saves in seconds. It starts at the nearest keyframe before your start.'
  else if (start - quickStart < 0.05) trimHint = 'Keeps full quality and saves in seconds. It starts exactly where you chose.'
  else
    trimHint = `Keeps full quality and saves in seconds. Videos can only be cut without re-encoding at keyframes, so it will start at ${clockTenths(quickStart)} — ${(start - quickStart).toFixed(1)} s before your start. Choose Exact to cut on the frame.`

  return (
    <div className="editor video-editor" role="dialog" aria-label="Edit video">
      <div className="ve-main">
        <div className="ve-player" ref={playerRef} onClick={() => !saving && toggle()}>
          {failed ? (
            <div className="viewer-error">
              <p>This video can't be played here, so it can't be edited.</p>
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          ) : (
            <video
              ref={videoRef}
              src={mediaUrl(item)}
              poster={thumbUrl(item)}
              style={videoStyle}
              preload="auto"
              playsInline
              disablePictureInPicture
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                setDims({ w: v.videoWidth, h: v.videoHeight })
                if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration)
                v.playbackRate = speed
                v.muted = mute
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onSeeked={(e) => setTime(e.currentTarget.currentTime)}
              onError={() => setFailed(true)}
            />
          )}
          {speed !== 1 && <span className="ve-badge">{speed}×</span>}
        </div>

        <div className="ve-transport">
          <button className="icon-btn" onClick={toggle} disabled={failed || saving} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            {playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <span className="ve-clock">
            {clockTenths(time)} <span>/ {clockTenths(duration)}</span>
          </span>
          <div className="ve-timeline" ref={lineRef} onPointerDown={onDown('seek')} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            <canvas ref={stripRef} className="ve-strip" />
            <div className="ve-shade" style={{ left: 0, width: pct(start) }} />
            <div className="ve-shade" style={{ left: pct(endAt), right: 0 }} />
            {quick && trimmed && start - quickStart >= 0.05 && (
              <div className="ve-keyframe" style={{ left: pct(quickStart), width: `calc(${pct(start)} - ${pct(quickStart)})` }} title={`The quick cut starts at this keyframe (${clockTenths(quickStart)})`} />
            )}
            <div className="ve-range" style={{ left: pct(start), width: `calc(${pct(endAt)} - ${pct(start)})` }}>
              <span className="ve-handle start" onPointerDown={onDown('start')} title="Drag to choose where it starts (I)" />
              <span className="ve-handle end" onPointerDown={onDown('end')} title="Drag to choose where it ends (O)" />
            </div>
            <div className="ve-playhead" style={{ left: pct(time) }} />
          </div>
        </div>
      </div>

      <aside className="editor-panel">
        <div className="editor-head">
          <h3>Edit video</h3>
          <button className="icon-btn" onClick={close} title="Close (Esc)" disabled={saving}>
            <X size={18} />
          </button>
        </div>
        <div className="editor-tools">
          {section(
            'Trim',
            <>
              <div className="ve-times">
                <button className="ve-time" onClick={() => seek(quick ? quickStart : start)} title="Go to the start">
                  <span>Start</span>
                  <b>{clockTenths(quick && trimmed ? quickStart : start)}</b>
                </button>
                <button className="ve-time" onClick={() => seek(endAt)} title="Go to the end">
                  <span>End</span>
                  <b>{clockTenths(endAt)}</b>
                </button>
                <div className="ve-time">
                  <span>Length</span>
                  <b>{clockTenths(lengthOut)}</b>
                </div>
              </div>
              <div className="edit-row">
                <button className="btn ghost" onClick={setStartHere} disabled={saving} title="Start here (I)">
                  Start here
                </button>
                <button className="btn ghost" onClick={setEndHere} disabled={saving} title="End here (O)">
                  End here
                </button>
              </div>
              <div className="edit-chips">
                <button className={`chip${quick ? ' active' : ''}`} onClick={() => setExact(false)} disabled={!!encodeReason || saving}>
                  Quick
                </button>
                <button className={`chip${!quick ? ' active' : ''}`} onClick={() => setExact(true)} disabled={saving}>
                  Exact
                </button>
              </div>
              <p className="edit-hint">{trimHint}</p>
            </>,
          )}
          {section(
            'Rotate',
            <div className="edit-row">
              <button className="btn ghost" onClick={() => setRotate((((rotate + 270) % 360) as VideoRecipe['rotate']))} disabled={saving} title="Turn left">
                <RotateCcw size={16} /> Left
              </button>
              <button className="btn ghost" onClick={() => setRotate((((rotate + 90) % 360) as VideoRecipe['rotate']))} disabled={saving} title="Turn right">
                <RotateCw size={16} /> Right
              </button>
              {rotate !== 0 && <span className="ve-note">{rotate === 180 ? 'Upside down' : rotate === 90 ? 'Turned right' : 'Turned left'}</span>}
            </div>,
          )}
          {section(
            'Sound & speed',
            <>
              <div className="edit-row">
                <button
                  className={`btn ghost${mute ? ' on' : ''}`}
                  onClick={() => setMute(!mute)}
                  disabled={saving || info?.hasAudio === false}
                  title={info?.hasAudio === false ? 'This video has no sound' : 'Save the copy without sound'}
                >
                  <VolumeX size={16} /> Remove sound {mute && <Check size={15} />}
                </button>
              </div>
              <div className="edit-chips">
                {SPEEDS.map((s) => (
                  <button key={s} className={`chip${speed === s ? ' active' : ''}`} onClick={() => setSpeed(s)} disabled={saving}>
                    {s === 1 ? 'Normal' : `${s}×`}
                  </button>
                ))}
              </div>
              {speed !== 1 && <p className="edit-hint">{speed < 1 ? 'Slow motion' : 'Faster'}: {clockTenths(lengthOut)} long. The sound keeps its pitch.</p>}
            </>,
          )}
          {section(
            'Photo from the video',
            <>
              <button className="btn enhance" onClick={saveFrame} disabled={!!busy || failed}>
                {busy === 'frame' ? <LoaderCircle size={16} className="spin" /> : <ImageDown size={16} />} Save this frame as a photo
              </button>
              <p className="edit-hint">
                A full-size JPEG of the frame at {clockTenths(time)}, dated {formatLongDate(frameDate)}, {formatTime(frameDate)}.
              </p>
            </>,
          )}
        </div>
        <div className="editor-foot">
          {saving ? (
            <>
              <div className="ve-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
                <div className="ve-progress-bar" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
                <span>{quick ? 'Saving…' : `Saving… ${Math.round((progress ?? 0) * 100)}%`}</span>
              </div>
              <button className="btn ghost" onClick={onAbort}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" disabled={!changed || !!busy} onClick={reset} title="Undo all changes (Ctrl+Z)">
                <Undo2 size={15} /> Reset
              </button>
              <div className="spacer" />
              <button className="btn primary" disabled={!changed || !!busy || failed} onClick={save} title="Save as a new copy (Ctrl+S)">
                <Check size={15} /> Save copy
              </button>
            </>
          )}
        </div>
        <p className="edit-note">Saved as a new file next to the original — your original is never changed.</p>
      </aside>

      {confirmClose && (
        <div className="modal-backdrop" onMouseDown={() => setConfirmClose(false)}>
          <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <h3>Discard your edits?</h3>
            <p>Nothing has been saved yet.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmClose(false)}>
                Keep editing
              </button>
              <button className="btn danger" onClick={onClose}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
