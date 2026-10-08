import { Check, Clapperboard, FolderOpen, LoaderCircle, Music, Play, RectangleHorizontal, RectangleVertical, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { thumbUrl } from '../api'
import { formatCount, formatDuration } from '../lib/format'
import type { MediaItem } from '../types'
import './movie.css'

/** What to make (main maps the ids to library items; see electron/movie.cjs makeMovie). */
export interface MovieRequest {
  /** In movie order. */
  ids: string[]
  title: string
  subtitle: string
  photoSeconds: number
  clipSeconds: number
  /** Clips keep their own sound (the music is lowered under them). */
  clipAudio: boolean
  /** An audio file, or null. */
  music: string | null
  size: 1080 | 720
  shape: 'landscape' | 'portrait'
}

export interface MovieProgress {
  phase: 'preparing' | 'rendering' | 'finishing'
  /** 0–1 overall. */
  fraction: number
  done: number
  total: number
  /** Frames drawn per second (while rendering). */
  fps?: number
}

export interface MovieResult {
  file: string
  /** Seconds of movie. */
  duration: number
  /** How long making it took (s). */
  seconds: number
  encoder: string
  /** Names of items that couldn't be read (left out / left dark). */
  skipped: string[]
}

interface Props {
  /** The photos and videos to choose from (a trip, a memory, an album, a selection). */
  items: MediaItem[]
  /** Suggested title card, e.g. "Goa" and "March 2023". */
  title?: string
  subtitle?: string
  /** While making. */
  progress: MovieProgress | null
  /** Makes the movie (asking where to save it); null = canceled. Throws with a plain message. */
  onMake(request: MovieRequest): Promise<MovieResult | null>
  /** Stops making it. */
  onAbort(): void
  /** Lets the person choose a music file; null = canceled. */
  onPickMusic(): Promise<string | null>
  onPlay(file: string): void
  onReveal(file: string): void
  onClose(): void
}

const FADE = 0.8
const TITLE_EXTRA = 1.5

/** How long the movie will be (s) — the same sums as electron/movie.cjs. */
export function movieLength(items: MediaItem[], o: { photoSeconds: number; clipSeconds: number; title: boolean }) {
  const parts = items.map((it) => (it.type === 'video' ? Math.min(o.clipSeconds, it.duration || o.clipSeconds) : o.photoSeconds))
  if (!parts.length) return 0
  if (o.title) parts[0] += TITLE_EXTRA
  let t = 0
  parts.forEach((d, i) => {
    const next = parts[i + 1]
    t += next ? d - Math.min(FADE, d / 3, next / 3) : d
  })
  return t
}

/** About `n` items spread evenly over time, mostly photos (up to a fifth clips). */
export function pickSpread(ordered: MediaItem[], n: number): Set<string> {
  if (n >= ordered.length) return new Set(ordered.map((it) => it.id))
  const photos = ordered.filter((it) => it.type !== 'video')
  const videos = ordered.filter((it) => it.type === 'video')
  let nv = Math.min(videos.length, Math.round(n * 0.2))
  const np = Math.min(photos.length, n - nv)
  nv = Math.min(videos.length, n - np)
  const spread = (list: MediaItem[], k: number) => Array.from({ length: k }, (_, i) => list[Math.floor(((i + 0.5) * list.length) / k)].id)
  return new Set([...spread(photos, np), ...spread(videos, nv)])
}

const fileName = (p: string) => p.split(/[\\/]/).pop() || p

type Stage = { kind: 'setup' } | { kind: 'making' } | { kind: 'done'; result: MovieResult } | { kind: 'error'; message: string }

export function MovieDialog({ items, title: suggestedTitle = '', subtitle: suggestedSubtitle = '', progress, onMake, onAbort, onPickMusic, onPlay, onReveal, onClose }: Props) {
  const byDate = useMemo(() => [...items].sort((a, b) => a.date - b.date), [items])
  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items])
  const [order, setOrder] = useState<string[]>(() => byDate.map((it) => it.id))
  const [chosen, setChosen] = useState<Set<string>>(() => pickSpread(byDate, 30))
  const [title, setTitle] = useState(suggestedTitle)
  const [subtitle, setSubtitle] = useState(suggestedSubtitle)
  const [photoSeconds, setPhotoSeconds] = useState(3.5)
  const [clipSeconds, setClipSeconds] = useState(5)
  const [clipAudio, setClipAudio] = useState(true)
  const [music, setMusic] = useState<string | null>(null)
  const [size, setSize] = useState<1080 | 720>(1080)
  const [shape, setShape] = useState<'landscape' | 'portrait'>('landscape')
  const [stage, setStage] = useState<Stage>({ kind: 'setup' })
  const [dragging, setDragging] = useState<string | null>(null)

  const sequence = order.filter((id) => chosen.has(id)).map((id) => byId.get(id)!).filter(Boolean)
  const photos = sequence.filter((it) => it.type !== 'video').length
  const clips = sequence.length - photos
  const length = movieLength(sequence, { photoSeconds, clipSeconds, title: !!(title.trim() || subtitle.trim()) })
  const position = new Map(sequence.map((it, i) => [it.id, i + 1]))
  const counts = [20, 30, 50].filter((n) => n < items.length)

  const pick = (n: number) => {
    const ordered = order.map((id) => byId.get(id)!).filter(Boolean)
    setChosen(pickSpread(ordered, n))
  }
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // drag a thumbnail onto another to move it there
  const onDragStart = (id: string) => (e: DragEvent) => {
    setDragging(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
  const onDragOver = (id: string) => (e: DragEvent) => {
    if (!dragging || dragging === id) return
    e.preventDefault()
    setOrder((prev) => {
      const from = prev.indexOf(dragging)
      const to = prev.indexOf(id)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...prev]
      next.splice(from, 1)
      next.splice(to, 0, dragging)
      return next
    })
  }

  const make = async () => {
    if (!sequence.length) return
    setStage({ kind: 'making' })
    try {
      const result = await onMake({
        ids: sequence.map((it) => it.id),
        title: title.trim(),
        subtitle: subtitle.trim(),
        photoSeconds,
        clipSeconds,
        clipAudio,
        music,
        size,
        shape,
      })
      setStage(result ? { kind: 'done', result } : { kind: 'setup' })
    } catch (err) {
      setStage({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
  const chooseMusic = async () => {
    const file = await onPickMusic()
    if (file) setMusic(file)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (stage.kind !== 'making') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const pct = Math.round((progress?.fraction ?? 0) * 100)
  const left = progress?.phase === 'rendering' && progress.fps ? Math.max(1, Math.round((progress.total - progress.done) / progress.fps)) : null

  return (
    <div className="modal-backdrop" onMouseDown={() => stage.kind === 'setup' && onClose()}>
      <div className={`modal movie-modal${stage.kind === 'setup' ? '' : ' compact'}`} role="dialog" aria-modal="true" aria-label="Make a movie" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mv-head">
          <Clapperboard size={20} />
          <h3>Make a movie</h3>
          <div className="spacer" />
          {stage.kind !== 'making' && (
            <button className="icon-btn" onClick={onClose} title="Close (Esc)">
              <X size={18} />
            </button>
          )}
        </div>

        {stage.kind === 'setup' && (
          <>
            <div className="mv-body">
              <div className="mv-titles">
                <input className="mv-input mv-title" value={title} placeholder="Title (optional)" maxLength={80} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
                <input className="mv-input" value={subtitle} placeholder="Second line, e.g. a date" maxLength={100} onChange={(e) => setSubtitle(e.target.value)} aria-label="Second line" />
              </div>

              <div className="mv-section-head">
                <h4>
                  {formatCount(sequence.length)} of {formatCount(items.length)} chosen
                </h4>
                <div className="spacer" />
                {counts.map((n) => (
                  <button key={n} className="chip" onClick={() => pick(n)}>
                    {n}
                  </button>
                ))}
                <button className="chip" onClick={() => pick(items.length)}>
                  All
                </button>
                <button className="chip" onClick={() => setChosen(new Set())}>
                  None
                </button>
              </div>
              <div className="mv-grid">
                {order.map((id) => {
                  const it = byId.get(id)
                  if (!it) return null
                  const n = position.get(id)
                  return (
                    <button
                      key={id}
                      className={`mv-tile${n ? ' on' : ''}${dragging === id ? ' dragging' : ''}`}
                      onClick={() => toggle(id)}
                      draggable
                      onDragStart={onDragStart(id)}
                      onDragOver={onDragOver(id)}
                      onDragEnd={() => setDragging(null)}
                      onDrop={(e) => e.preventDefault()}
                      title={`${it.name}${n ? ` — #${n} in the movie (drag to move)` : ' — click to add'}`}
                    >
                      <img src={thumbUrl(it)} alt="" loading="lazy" draggable={false} />
                      {it.type === 'video' && (
                        <span className="mv-dur">
                          <Play size={9} fill="currentColor" /> {formatDuration(it.duration) || 'Video'}
                        </span>
                      )}
                      {n ? <span className="mv-num">{n}</span> : null}
                    </button>
                  )
                })}
              </div>
              <p className="mv-hint">Click to add or leave out; drag to change the order.</p>

              <div className="mv-options">
                <label className="mv-option">
                  <span>
                    Each photo <b>{photoSeconds.toFixed(1)} s</b>
                  </span>
                  <input type="range" min={2} max={6} step={0.5} value={photoSeconds} onChange={(e) => setPhotoSeconds(Number(e.target.value))} />
                </label>
                <label className={`mv-option${clips ? '' : ' off'}`}>
                  <span>
                    Video clips up to <b>{clipSeconds} s</b>
                  </span>
                  <input type="range" min={2} max={10} step={1} value={clipSeconds} disabled={!clips} onChange={(e) => setClipSeconds(Number(e.target.value))} />
                </label>
                <div className="mv-option">
                  <span>Music</span>
                  {music ? (
                    <div className="mv-music">
                      <Music size={15} />
                      <span title={music}>{fileName(music)}</span>
                      <button className="icon-btn tiny" onClick={() => setMusic(null)} title="No music">
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <button className="btn" onClick={chooseMusic}>
                      <Music size={15} /> Choose music…
                    </button>
                  )}
                  <small>Loops or fades out to fit the movie.</small>
                </div>
                <div className={`mv-option${clips ? '' : ' off'}`}>
                  <span>Sound of the clips</span>
                  <div className="mv-switch-row">
                    <button role="switch" aria-checked={clipAudio} aria-label="Keep the clips' own sound" disabled={!clips} className={`switch${clipAudio ? ' on' : ''}`} onClick={() => setClipAudio(!clipAudio)}>
                      <span />
                    </button>
                    <small>{clipAudio ? (music ? 'On — the music is lowered under them' : 'On') : 'Off'}</small>
                  </div>
                </div>
                <div className="mv-option">
                  <span>Size</span>
                  <div className="segmented small">
                    <button className={size === 1080 ? 'active' : ''} onClick={() => setSize(1080)}>
                      1080p
                    </button>
                    <button className={size === 720 ? 'active' : ''} onClick={() => setSize(720)}>
                      720p
                    </button>
                  </div>
                </div>
                <div className="mv-option">
                  <span>Shape</span>
                  <div className="segmented small">
                    <button className={shape === 'landscape' ? 'active' : ''} onClick={() => setShape('landscape')}>
                      <RectangleHorizontal size={14} /> Wide
                    </button>
                    <button className={shape === 'portrait' ? 'active' : ''} onClick={() => setShape('portrait')}>
                      <RectangleVertical size={14} /> Phone
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="mv-foot">
              <span className="mv-summary">
                {sequence.length ? (
                  <>
                    About {formatDuration(Math.max(1, length))} · {photos ? `${formatCount(photos)} photo${photos === 1 ? '' : 's'}` : ''}
                    {photos && clips ? ', ' : ''}
                    {clips ? `${formatCount(clips)} clip${clips === 1 ? '' : 's'}` : ''}
                  </>
                ) : (
                  'Choose some photos'
                )}
              </span>
              <div className="spacer" />
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={!sequence.length} onClick={make}>
                <Clapperboard size={15} /> Make movie
              </button>
            </div>
          </>
        )}

        {stage.kind === 'making' && (
          <div className="mv-status">
            <LoaderCircle size={30} className="spin mv-status-icon" />
            <h4>{progress?.phase === 'finishing' ? 'Finishing…' : progress?.phase === 'rendering' ? 'Making your movie…' : 'Getting ready…'}</h4>
            <div className="mv-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <div style={{ width: `${pct}%` }} />
            </div>
            <p>
              {pct}%{left ? ` · about ${formatDuration(left)} left` : ''}
            </p>
            <div className="mv-status-actions">
              <button className="btn" onClick={onAbort}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {stage.kind === 'done' && (
          <div className="mv-status">
            <span className="mv-done-icon">
              <Check size={24} />
            </span>
            <h4>Your movie is ready</h4>
            <p className="mv-file" title={stage.result.file}>
              {fileName(stage.result.file)}
            </p>
            <p>
              {formatDuration(stage.result.duration)} long · made in {formatDuration(Math.max(1, stage.result.seconds))}
            </p>
            {stage.result.skipped.length > 0 && (
              <p className="mv-warn">
                <TriangleAlert size={14} /> {stage.result.skipped.length === 1 ? `${stage.result.skipped[0]} couldn't be read.` : `${stage.result.skipped.length} items couldn't be read.`}
              </p>
            )}
            <div className="mv-status-actions">
              <button className="btn" onClick={() => onReveal(stage.result.file)}>
                <FolderOpen size={15} /> Show in folder
              </button>
              <button className="btn primary" onClick={() => onPlay(stage.result.file)}>
                <Play size={15} /> Play
              </button>
            </div>
            <button className="btn ghost mv-again" onClick={() => setStage({ kind: 'setup' })}>
              Make another version
            </button>
          </div>
        )}

        {stage.kind === 'error' && (
          <div className="mv-status">
            <span className="mv-error-icon">
              <TriangleAlert size={24} />
            </span>
            <h4>The movie couldn't be made</h4>
            <p>{stage.message}</p>
            <div className="mv-status-actions">
              <button className="btn" onClick={onClose}>
                Close
              </button>
              <button className="btn primary" onClick={() => setStage({ kind: 'setup' })}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

