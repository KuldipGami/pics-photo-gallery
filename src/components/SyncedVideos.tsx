import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { mediaUrl, thumbUrl } from '../api'
import type { MediaItem } from '../types'
import './synced-videos.css'

// Plays the videos of a duplicate group side by side on one clock (ported from DupeLens' VideoSync
// and SyncedVideoPlayer). Each clip sits on the longest clip's timeline at its own offset (a
// trimmed copy starts later), so the same moment plays everywhere; players that drift more than
// DRIFT seconds from the clock are put back. Only one video is heard at a time.

const TICK_MS = 100
const DRIFT = 0.35
const END = 0.05 // a clip counts as ended this close to its end

/** m:ss, or h:mm:ss from an hour. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export interface SyncedVideosHandle {
  toggle(): void
  play(): void
  pause(): void
  /** Position on the shared timeline (seconds). */
  seek(seconds: number): void
  skip(seconds: number): void
}

interface Props {
  items: MediaItem[]
  /** Where each clip starts on the longest clip's timeline (seconds); DupGroup.offsets. */
  offsets: number[]
  /** The best copy: its sound plays by default. */
  refIndex: number
  /** Drawn over each player (badges, numbers…). */
  overlay?: (index: number) => ReactNode
  /** Drawn under each player (name, size…), inside its column. */
  footer?: (index: number) => ReactNode
  /** A player was clicked (it also plays / pauses everything). */
  onSelect?: (index: number) => void
  ref?: Ref<SyncedVideosHandle>
}

export function SyncedVideos({ items, offsets, refIndex, overlay, footer, onSelect, ref }: Props) {
  const players = useRef<(HTMLVideoElement | null)[]>([])
  const [lengths, setLengths] = useState<number[]>(() => items.map((it) => it.duration ?? 0))
  const [failed, setFailed] = useState<boolean[]>([])
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [audio, setAudio] = useState(refIndex) // -1: sound off
  // The clock lives in a ref so the timer and media events always see the current values.
  const state = useRef({ playing: false, position: 0, from: 0, since: 0, duration: 0, lengths: [] as number[], offsets: [] as number[] })

  const offset = (i: number) => Math.max(0, offsets[i] ?? 0)
  const lengthOf = (i: number) => lengths[i] || items[i]?.duration || 0
  const duration = Math.max(0, ...items.map((_, i) => offset(i) + lengthOf(i)))
  const s = state.current
  s.duration = duration
  s.lengths = items.map((_, i) => lengthOf(i))
  s.offsets = items.map((_, i) => offset(i))

  /** Puts one player where the clock says (`force`: exactly, after a seek / play / pause). */
  const syncOne = (i: number, force: boolean) => {
    const v = players.current[i]
    if (!v || v.readyState < HTMLMediaElement.HAVE_METADATA) return
    const length = s.lengths[i] || v.duration || 0
    const local = s.position - s.offsets[i]
    const before = local < 0
    const after = length > 0 && local >= length - END
    if (s.playing && !before && !after) {
      if (v.paused) {
        v.currentTime = local
        v.play().catch(() => {})
      } else if (force || (!v.seeking && Math.abs(v.currentTime - local) > DRIFT)) {
        v.currentTime = local // drifted: catch up with the clock
      }
      return
    }
    const wasPlaying = !v.paused
    if (wasPlaying) v.pause()
    if (force || wasPlaying) v.currentTime = Math.min(Math.max(0, local), Math.max(0, length - END))
  }
  const syncAll = (force: boolean) => items.forEach((_, i) => syncOne(i, force))

  const now = () => (s.playing ? Math.min(s.duration, s.from + (performance.now() - s.since) / 1000) : s.position)

  const pause = () => {
    s.position = now()
    s.playing = false
    setPlaying(false)
    setPosition(s.position)
    syncAll(true)
  }
  const play = () => {
    if (!items.length || s.duration <= 0) return
    if (s.position >= s.duration - 0.1) s.position = 0
    s.from = s.position
    s.since = performance.now()
    s.playing = true
    setPlaying(true)
    setPosition(s.position)
    syncAll(true)
  }
  const seek = (seconds: number) => {
    s.position = Math.min(Math.max(0, seconds), s.duration)
    s.from = s.position
    s.since = performance.now()
    setPosition(s.position)
    syncAll(true)
  }
  const toggle = () => (s.playing ? pause() : play())
  const skip = (seconds: number) => seek(now() + seconds)

  useImperativeHandle(ref, () => ({ toggle, play, pause, seek, skip }))

  // the shared clock
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      s.position = now()
      if (s.position >= s.duration) {
        pause()
        return
      }
      setPosition(s.position)
      syncAll(false)
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [playing])

  // a new comparison: stop and rewind
  const key = items.map((it) => `${it.id}:${it.mtime}`).join('|')
  useEffect(() => {
    s.playing = false
    s.position = 0
    setPlaying(false)
    setPosition(0)
    setLengths(items.map((it) => it.duration ?? 0))
    setFailed([])
    setAudio(refIndex)
    for (const v of players.current) if (v && !v.paused) v.pause()
  }, [key])
  useEffect(() => setAudio(refIndex), [refIndex])

  // one audible player
  useEffect(() => {
    players.current.forEach((v, i) => {
      if (v) v.muted = i !== audio
    })
  }, [audio, key])

  // stop for good when the comparison closes
  useEffect(
    () => () => {
      for (const v of players.current) v?.pause()
    },
    [],
  )

  const onMetadata = (i: number, v: HTMLVideoElement) => {
    v.muted = i !== audio
    if (Number.isFinite(v.duration) && v.duration > 0 && Math.abs(v.duration - (lengths[i] || 0)) > 0.01) {
      setLengths((prev) => {
        const next = items.map((it, k) => prev[k] || it.duration || 0)
        next[i] = v.duration
        return next
      })
      s.lengths[i] = v.duration
    }
    syncOne(i, true) // a player that just opened jumps to the current moment
  }

  const several = items.length > 1
  return (
    <div className="sv">
      <div className="sv-row" style={{ gridTemplateColumns: `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))` }}>
        {items.map((it, i) => {
          const local = position - offset(i)
          const length = lengthOf(i)
          const before = local < 0
          const after = length > 0 && local >= length - END
          return (
            <div key={it.id} className="sv-col">
              <div
                className="sv-player"
                onClick={() => {
                  onSelect?.(i)
                  toggle()
                }}
                title="Click to play or pause all videos"
              >
                <video
                  ref={(v) => {
                    players.current[i] = v
                  }}
                  src={mediaUrl(it)}
                  poster={thumbUrl(it)}
                  preload="auto"
                  playsInline
                  disablePictureInPicture
                  onLoadedMetadata={(e) => onMetadata(i, e.currentTarget)}
                  onError={() => setFailed((prev) => Object.assign([...prev], { [i]: true }))}
                />
                {failed[i] ? (
                  <div className="sv-veil">This video can't be played here.</div>
                ) : several && before ? (
                  <div className="sv-veil">This clip starts in {clock(Math.ceil(-local))}</div>
                ) : several && after ? (
                  <div className="sv-veil">This clip has ended</div>
                ) : null}
                {offset(i) >= 1 && <span className="sv-pill">Starts {clock(Math.round(offset(i)))} into the longest clip</span>}
                <button
                  className={`sv-sound${audio === i ? ' on' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setAudio(audio === i ? -1 : i)
                  }}
                  title={audio === i ? 'Sound is playing from this video (click to mute)' : 'Play sound from this video'}
                >
                  {audio === i ? <Volume2 size={15} /> : <VolumeX size={15} />}
                </button>
                {overlay?.(i)}
              </div>
              {footer?.(i)}
            </div>
          )
        })}
      </div>
      <div className="sv-bar">
        <button className="icon-btn" onClick={toggle} title={playing ? 'Pause' : 'Play'} disabled={!duration}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="btn ghost sv-skip" onClick={() => skip(-10)} title="Back 10 seconds">
          −10 s
        </button>
        <button className="btn ghost sv-skip" onClick={() => skip(30)} title="Forward 30 seconds">
          +30 s
        </button>
        <input
          className="sv-timeline"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(position, duration)}
          onChange={(e) => seek(Number(e.currentTarget.value))}
          aria-label="Position"
          style={{ '--sv-fill': `${duration ? (Math.min(position, duration) / duration) * 100 : 0}%` } as CSSProperties}
        />
        <span className="sv-time">
          {clock(position)} / {clock(duration)}
        </span>
        <select className="sv-audio" value={audio} onChange={(e) => setAudio(Number(e.currentTarget.value))} aria-label="Sound">
          <option value={-1}>Sound off</option>
          {items.map((it, i) => (
            <option key={it.id} value={i}>
              Sound from {i + 1}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
