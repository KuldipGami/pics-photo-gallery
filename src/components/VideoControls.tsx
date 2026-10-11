import { Check, Download, Ellipsis, Maximize, Minimize, Pause, PictureInPicture2, Play, Repeat, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import './video-controls.css'

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** 0:07, 4:05, 1:02:03 */
export function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

interface State {
  playing: boolean
  time: number
  duration: number
  /** How far it's loaded from where it plays now (seconds). */
  buffered: number
  volume: number
  muted: boolean
  rate: number
  loop: boolean
  pip: boolean
  fullscreen: boolean
}

const read = (v: HTMLVideoElement, frame: HTMLElement | null): State => {
  let buffered = 0
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) buffered = v.buffered.end(i)
  }
  return {
    playing: !v.paused && !v.ended,
    time: v.currentTime,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    buffered,
    volume: v.volume,
    muted: v.muted,
    rate: v.playbackRate,
    loop: v.loop,
    pip: document.pictureInPictureElement === v,
    fullscreen: !!frame && document.fullscreenElement === frame,
  }
}

/**
 * Pics' own controls for a <video>, in place of Chromium's: play, a seek bar that shows what's
 * loaded and the time under the pointer, the time, volume, speed, picture in picture, full screen
 * and a menu (loop, save a copy). `frame` is what goes full screen: the element holding the video
 * and these controls. Clicks and drags on the bar don't reach what's behind it (Compare pans).
 */
export function VideoControls({
  video,
  frame,
  onSaveCopy,
  className = '',
  ...rest
}: {
  video: HTMLVideoElement | null
  frame: RefObject<HTMLElement | null>
  /** "Save a copy…" in the menu. */
  onSaveCopy?(): void
  className?: string
  onMouseEnter?(): void
  onMouseLeave?(): void
}) {
  const [s, setS] = useState<State | null>(null)
  const [menu, setMenu] = useState<'speed' | 'more' | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const seekRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ wasPlaying: boolean } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!video) return setS(null)
    const update = () => setS(read(video, frame.current))
    const events = ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata', 'progress', 'volumechange', 'ratechange', 'seeking', 'seeked', 'enterpictureinpicture', 'leavepictureinpicture', 'emptied']
    for (const e of events) video.addEventListener(e, update)
    document.addEventListener('fullscreenchange', update)
    update()
    // smooth progress while it plays (timeupdate only comes a few times a second)
    let raf = 0
    const tick = () => {
      update()
      raf = video.paused ? 0 : requestAnimationFrame(tick)
    }
    const onPlay = () => {
      if (!raf) raf = requestAnimationFrame(tick)
    }
    video.addEventListener('play', onPlay)
    if (!video.paused) onPlay()
    return () => {
      for (const e of events) video.removeEventListener(e, update)
      video.removeEventListener('play', onPlay)
      document.removeEventListener('fullscreenchange', update)
      cancelAnimationFrame(raf)
    }
  }, [video, frame])

  // a menu closes on a click elsewhere or Esc (and doesn't let Esc close the viewer)
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setMenu(null)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  if (!video || !s) return null
  const { duration } = s
  const pct = (t: number) => `${duration ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0}%`

  const togglePlay = () => (video.paused || video.ended ? void video.play().catch(() => {}) : video.pause())
  const seekTo = (t: number) => {
    if (!duration) return
    video.currentTime = Math.min(duration, Math.max(0, t))
    setS(read(video, frame.current))
  }
  const at = (e: PointerEvent) => {
    const r = seekRef.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration
  }
  const onSeekDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !duration) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { wasPlaying: !video.paused }
    video.pause() // (scrubbing: the frame follows the pointer, playing goes on after)
    seekTo(at(e))
  }
  const onSeekMove = (e: PointerEvent<HTMLDivElement>) => {
    setHover(at(e))
    if (drag.current) seekTo(at(e))
  }
  const onSeekUp = () => {
    if (drag.current?.wasPlaying) void video.play().catch(() => {})
    drag.current = null
  }
  const onSeekKey = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      return togglePlay()
    }
    const step = e.shiftKey ? 1 : 5
    const to: Record<string, number> = {
      ArrowLeft: s.time - step,
      ArrowDown: s.time - step,
      ArrowRight: s.time + step,
      ArrowUp: s.time + step,
      PageDown: s.time - duration / 10,
      PageUp: s.time + duration / 10,
      Home: 0,
      End: duration,
    }
    if (!(e.key in to)) return
    e.preventDefault()
    e.stopPropagation() // (the viewer would go to the next photo)
    seekTo(to[e.key])
  }
  const setVolume = (v: number) => {
    video.volume = v
    video.muted = v === 0
  }
  const toggleMute = () => {
    if (video.muted && video.volume === 0) video.volume = 0.5
    video.muted = !video.muted
  }
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    } catch {}
  }
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await frame.current?.requestFullscreen()
    } catch {}
  }
  const canPip = document.pictureInPictureEnabled && !video.disablePictureInPicture
  const VolumeIcon = s.muted || s.volume === 0 ? VolumeX : s.volume < 0.5 ? Volume1 : Volume2
  // buttons keep focus where it was, so Space still plays/pauses afterwards (not "press the button again")
  const noFocus = { onMouseDown: (e: { preventDefault(): void }) => e.preventDefault() }
  const item = (label: string, icon: ReactNode, onClick: () => void, on = false) => (
    <button
      key={label}
      className={`vc-menu-item${on ? ' on' : ''}`}
      role="menuitemcheckbox"
      aria-checked={on}
      {...noFocus}
      onClick={() => {
        setMenu(null)
        onClick()
      }}
    >
      <span className="vc-menu-icon">{icon}</span>
      {label}
    </button>
  )

  return (
    <div
      ref={barRef}
      className={`vc${s.playing ? '' : ' paused'} ${className}`}
      // (Compare pans and zooms on drags and double-clicks behind it)
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      {...rest}
    >
      <button className="vc-btn" {...noFocus} onClick={togglePlay} title={s.playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={s.playing ? 'Pause' : 'Play'}>
        {s.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <span className="vc-time">
        {clock(s.time)} <span className="vc-total">/ {clock(duration)}</span>
      </span>
      <div
        ref={seekRef}
        className="vc-seek"
        role="slider"
        tabIndex={0}
        aria-label="Position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(s.time)}
        aria-valuetext={`${clock(s.time)} of ${clock(duration)}`}
        {...noFocus}
        onPointerDown={onSeekDown}
        onPointerMove={onSeekMove}
        onPointerUp={onSeekUp}
        onPointerCancel={onSeekUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onSeekKey}
      >
        <div className="vc-track">
          <div className="vc-buffered" style={{ width: pct(s.buffered) }} />
          {hover !== null && <div className="vc-hovered" style={{ width: pct(hover) }} />}
          <div className="vc-played" style={{ width: pct(s.time) }} />
        </div>
        <div className="vc-thumb" style={{ left: pct(s.time) }} />
        {hover !== null && (
          <div className="vc-tip" style={{ '--x': pct(hover) } as CSSProperties}>
            {clock(hover)}
          </div>
        )}
      </div>
      <div className="vc-volume">
        <button className="vc-btn" {...noFocus} onClick={toggleMute} title={s.muted ? 'Sound on (M)' : 'Mute (M)'} aria-label={s.muted ? 'Sound on' : 'Mute'}>
          <VolumeIcon size={18} />
        </button>
        <input
          className="vc-range"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={s.muted ? 0 : s.volume}
          onChange={(e) => setVolume(Number(e.currentTarget.value))}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key !== ' ') return
            e.preventDefault()
            togglePlay()
          }}
          aria-label="Volume"
          style={{ '--fill': `${(s.muted ? 0 : s.volume) * 100}%` } as CSSProperties}
        />
      </div>
      <div className="vc-anchor">
        <button className={`vc-btn vc-speed${s.rate !== 1 ? ' on' : ''}`} {...noFocus} onClick={() => setMenu(menu === 'speed' ? null : 'speed')} title="Playback speed" aria-haspopup="menu" aria-expanded={menu === 'speed'}>
          {s.rate}×
        </button>
        {menu === 'speed' && (
          <div className="vc-menu" role="menu" aria-label="Playback speed">
            <div className="vc-menu-head">Playback speed</div>
            {SPEEDS.map((r) => item(r === 1 ? 'Normal' : `${r}×`, r === s.rate ? <Check size={14} /> : null, () => (video.playbackRate = r), r === s.rate))}
          </div>
        )}
      </div>
      {canPip && (
        <button className={`vc-btn vc-pip${s.pip ? ' on' : ''}`} {...noFocus} onClick={togglePip} title={s.pip ? 'Back from picture in picture' : 'Picture in picture'} aria-label="Picture in picture">
          <PictureInPicture2 size={18} />
        </button>
      )}
      <div className="vc-anchor">
        <button className={`vc-btn${menu === 'more' ? ' on' : ''}`} {...noFocus} onClick={() => setMenu(menu === 'more' ? null : 'more')} title="More" aria-haspopup="menu" aria-expanded={menu === 'more'}>
          <Ellipsis size={18} />
        </button>
        {menu === 'more' && (
          <div className="vc-menu" role="menu">
            {item('Loop', s.loop ? <Check size={14} /> : <Repeat size={14} />, () => (video.loop = !video.loop), s.loop)}
            {onSaveCopy && item('Save a copy…', <Download size={14} />, onSaveCopy)}
          </div>
        )}
      </div>
      <button className="vc-btn" {...noFocus} onClick={toggleFullscreen} title={s.fullscreen ? 'Exit full screen (double-click)' : 'Full screen (double-click)'} aria-label="Full screen">
        {s.fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
      </button>
    </div>
  )
}
