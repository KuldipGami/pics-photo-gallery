import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  Heart,
  ImagePlus,
  Info,
  Pause,
  Play,
  SlidersHorizontal,
  Trash,
  VideoOff,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { api, mediaUrl, thumbUrl } from '../api'
import { useElementSize } from '../hooks'
import { formatDuration, formatLongDate, formatTime } from '../lib/format'
import type { FaceBox, MediaItem, Place } from '../types'
import { InfoPanel, type PhotoFace } from './InfoPanel'
import { PhotoEditor } from './PhotoEditor'
import { ZoomableImage, type ZoomControls } from './ZoomableImage'

interface Props {
  items: MediaItem[]
  index: number
  favorites: Set<string>
  onIndex(index: number): void
  onClose(): void
  onToggleFavorite(item: MediaItem): void
  onDelete(item: MediaItem): void
  onToast(text: string): void
  facesIn(itemId: string): PhotoFace[]
  onOpenPerson(id: string): void
  onAssignFace(face: PhotoFace): void
  onRemoveFace(face: PhotoFace): void
  onAddToAlbum(item: MediaItem): void
  placeOf(itemId: string): Place | undefined
  onOpenPlace(id: string): void
  /** The motion clip of a Live Photo. */
  liveOf(itemId: string): MediaItem | undefined
  /** An edited copy was saved (it appears in the library a moment later). */
  onEdited(original: MediaItem, id: string, name: string): void
  onLocate?(item: MediaItem): void
}

const SLIDE_MS = 4000
const IDLE_MS = 2600

const readPref = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writePref = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

export function Viewer({
  items,
  index,
  favorites,
  onIndex,
  onClose,
  onToggleFavorite,
  onDelete,
  onToast,
  facesIn,
  onOpenPerson,
  onAssignFace,
  onRemoveFace,
  onAddToAlbum,
  placeOf,
  onOpenPlace,
  liveOf,
  onEdited,
  onLocate,
}: Props) {
  const item = items[index]
  const [editing, setEditing] = useState(false)
  const [livePlaying, setLivePlaying] = useState(false)
  const live = item?.type === 'image' ? liveOf(item.id) : undefined
  useEffect(() => setLivePlaying(false), [item?.id])
  const [showInfo, setShowInfo] = useState(() => readPref('lumen.info') === '1')
  const [idle, setIdle] = useState(false)
  const [slideshow, setSlideshow] = useState(false)
  const [dims, setDims] = useState<{ id: string; w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState({ actual: 1, zoomed: false })
  const [highlight, setHighlight] = useState<FaceBox | null>(null)
  const zoomControls = useRef<ZoomControls | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const idleTimer = useRef(0)
  const overChrome = useRef(false)

  const count = items.length
  const go = useCallback((i: number) => onIndex(Math.max(0, Math.min(count - 1, i))), [onIndex, count])
  const next = () => (index < count - 1 ? go(index + 1) : slideshow ? go(0) : undefined)
  const prev = () => go(index - 1)

  const poke = () => {
    setIdle(false)
    clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => {
      if (!overChrome.current) setIdle(true)
    }, IDLE_MS)
  }
  useEffect(() => {
    poke()
    return () => clearTimeout(idleTimer.current)
  }, [])

  useEffect(() => writePref('lumen.info', showInfo ? '1' : '0'), [showInfo])

  // Zoom belongs to the image being shown; videos and the next photo start un-zoomed.
  useEffect(() => {
    setZoom({ actual: 1, zoomed: false })
    setHighlight(null)
  }, [item?.id])

  // Slideshow: images advance on a timer, videos when they finish.
  useEffect(() => {
    if (!slideshow || item?.type !== 'image') return
    const t = setTimeout(next, SLIDE_MS)
    return () => clearTimeout(t)
  }, [slideshow, index, item?.type])

  // Preload neighbours for instant navigation.
  useEffect(() => {
    for (const i of [index + 1, index - 1]) {
      const it = items[i]
      if (it?.type === 'image') new Image().src = thumbUrl(it)
    }
  }, [index, items])

  const copyImage = async () => {
    if (item.type !== 'image') return
    onToast((await api.copy(item.id, 'image')) ? 'Image copied to clipboard' : "Couldn't copy this image")
  }

  const toggleSlideshow = () => {
    if (!slideshow) {
      setIdle(true)
      onToast('Slideshow started · Esc to stop')
    }
    setSlideshow(!slideshow)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
      const inVideo = document.activeElement instanceof HTMLVideoElement
      const mod = e.ctrlKey || e.metaKey || e.altKey
      if (mod && /^[ifIF0+=-]$/.test(e.key)) return
      switch (e.key) {
        case 'Escape':
          if (slideshow) setSlideshow(false)
          else onClose()
          break
        case 'ArrowRight':
          if (!inVideo) next()
          break
        case 'ArrowLeft':
          if (!inVideo) prev()
          break
        case 'Home':
          go(0)
          break
        case 'End':
          go(count - 1)
          break
        case ' ':
          if (inVideo) return
          e.preventDefault()
          if (item.type === 'video' && videoRef.current) {
            const v = videoRef.current
            if (v.paused) v.play()
            else v.pause()
          } else {
            toggleSlideshow()
          }
          break
        case 'i':
        case 'I':
          setShowInfo((s) => !s)
          break
        case 'f':
        case 'F':
          onToggleFavorite(item)
          break
        case 'Delete':
          onDelete(item)
          break
        case '+':
        case '=':
          zoomControls.current?.zoom(1.25)
          break
        case '-':
          zoomControls.current?.zoom(0.8)
          break
        case '0':
          zoomControls.current?.reset()
          break
        case 'c':
          if (e.ctrlKey) copyImage()
          break
        case 'e':
        case 'E':
          if (item.type === 'image' && !mod) setEditing(true)
          break
        case 'l':
        case 'L':
          if (live && !mod) setLivePlaying(true)
          break
        default:
          return
      }
      poke()
    }
    if (editing) return
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onZoom = useCallback((actual: number, zoomed: boolean) => setZoom({ actual, zoomed }), [])
  const itemId = item?.id ?? ''
  const onDims = useCallback((w: number, h: number) => setDims({ id: itemId, w, h }), [itemId])

  if (!item) return null
  const fav = favorites.has(item.id)
  const chromeProps = {
    onMouseEnter: () => {
      overChrome.current = true
    },
    onMouseLeave: () => {
      overChrome.current = false
    },
  }

  return (
    <div
      className={`viewer${idle ? ' idle' : ''}${showInfo ? ' info-open' : ''}`}
      onMouseMove={poke}
      onMouseDown={poke}
    >
      <div className="viewer-backdrop">
        <img src={thumbUrl(item)} alt="" />
      </div>

      <div className="viewer-body">
        <div className="viewer-main">
          <div className="viewer-stage">
            {item.type === 'image' ? (
              <>
                <ZoomableImage
                  key={item.id}
                  item={item}
                  controls={zoomControls}
                  onDims={onDims}
                  onZoom={onZoom}
                  highlight={highlight}
                />
                {live && livePlaying && (
                  <video
                    key={live.id}
                    className="live-video"
                    src={mediaUrl(live)}
                    autoPlay
                    playsInline
                    muted={readPref('lumen.muted') === '1'}
                    onEnded={() => setLivePlaying(false)}
                    onError={() => setLivePlaying(false)}
                    onClick={() => setLivePlaying(false)}
                  />
                )}
              </>
            ) : (
              <VideoPlayer
                key={item.id}
                item={item}
                videoRef={videoRef}
                onDims={onDims}
                onEnded={() => slideshow && next()}
              />
            )}
          </div>

          {index > 0 && !zoom.zoomed && (
            <button className="viewer-nav prev chrome" onClick={prev} aria-label="Previous" {...chromeProps}>
              <ChevronLeft size={26} />
            </button>
          )}
          {index < count - 1 && !zoom.zoomed && (
            <button className="viewer-nav next chrome" onClick={next} aria-label="Next" {...chromeProps}>
              <ChevronRight size={26} />
            </button>
          )}

          <div className="viewer-topbar chrome" {...chromeProps}>
            <button className="icon-btn" onClick={onClose} title="Back (Esc)">
              <ArrowLeft size={20} />
            </button>
            <div className="viewer-title">
              <div className="viewer-name">{item.name}</div>
              <div className="viewer-date">
                {formatLongDate(item.date)} · {formatTime(item.date)}
                <span className="viewer-pos">
                  {index + 1} / {count}
                </span>
              </div>
            </div>
            <div className="viewer-actions">
              {live && (
                <button
                  className={`live-btn${livePlaying ? ' on' : ''}`}
                  onClick={() => setLivePlaying((p) => !p)}
                  title="Play the Live Photo (L)"
                >
                  <span className="live-dot" /> LIVE
                </button>
              )}
              {item.type === 'image' && (
                <div className="zoom-group">
                  <button className="icon-btn" onClick={() => zoomControls.current?.zoom(0.8)} title="Zoom out (−)">
                    <ZoomOut size={18} />
                  </button>
                  <button className="zoom-pct" onClick={() => zoomControls.current?.reset()} title="Fit to window (0)">
                    {Math.round(zoom.actual * 100)}%
                  </button>
                  <button className="icon-btn" onClick={() => zoomControls.current?.zoom(1.25)} title="Zoom in (+)">
                    <ZoomIn size={18} />
                  </button>
                </div>
              )}
              <button
                className={`icon-btn${slideshow ? ' on' : ''}`}
                onClick={toggleSlideshow}
                title={slideshow ? 'Stop slideshow (Space)' : 'Slideshow (Space)'}
              >
                {slideshow ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button
                className={`icon-btn${fav ? ' fav' : ''}`}
                onClick={() => onToggleFavorite(item)}
                title={fav ? 'Remove from favorites (F)' : 'Add to favorites (F)'}
              >
                <Heart size={18} fill={fav ? 'currentColor' : 'none'} />
              </button>
              <button className="icon-btn" onClick={() => onAddToAlbum(item)} title="Add to album">
                <ImagePlus size={18} />
              </button>
              {item.type === 'image' && (
                <button className="icon-btn" onClick={() => setEditing(true)} title="Edit (E)">
                  <SlidersHorizontal size={18} />
                </button>
              )}
              {item.type === 'image' && (
                <button className="icon-btn" onClick={copyImage} title="Copy image (Ctrl+C)">
                  <Copy size={18} />
                </button>
              )}
              <button className="icon-btn" onClick={() => api.openExternal(item.id)} title="Open with default app">
                <ExternalLink size={18} />
              </button>
              <button className="icon-btn" onClick={() => api.reveal(item.id)} title="Show in folder">
                <FolderOpen size={18} />
              </button>
              <button className="icon-btn" onClick={() => onDelete(item)} title="Move to Recycle Bin (Del)">
                <Trash size={18} />
              </button>
              <button
                className={`icon-btn${showInfo ? ' on' : ''}`}
                onClick={() => setShowInfo((s) => !s)}
                title="Details (I)"
              >
                <Info size={18} />
              </button>
            </div>
          </div>

          <Filmstrip items={items} index={index} onSelect={go} chromeProps={chromeProps} />
        </div>

        {showInfo && (
          <InfoPanel
            item={item}
            dims={dims?.id === item.id ? dims : null}
            faces={facesIn(item.id)}
            place={placeOf(item.id)}
            onOpenPlace={onOpenPlace}
            onOpenPerson={onOpenPerson}
            onAssignFace={onAssignFace}
            onRemoveFace={onRemoveFace}
            onHighlight={setHighlight}
            onClose={() => setShowInfo(false)}
            onToast={onToast}
            onLocate={onLocate}
          />
        )}
      </div>
      {editing && item.type === 'image' && (
        <PhotoEditor
          key={item.id}
          item={item}
          onClose={() => setEditing(false)}
          onToast={onToast}
          onSaved={(id, name) => {
            setEditing(false)
            onEdited(item, id, name)
          }}
        />
      )}
    </div>
  )
}

function VideoPlayer({
  item,
  videoRef,
  onDims,
  onEnded,
}: {
  item: MediaItem
  videoRef: RefObject<HTMLVideoElement | null>
  onDims(w: number, h: number): void
  onEnded(): void
}) {
  const [error, setError] = useState(false)
  const [resumed, setResumed] = useState<number | null>(null)
  const lastSave = useRef(0)
  useEffect(() => {
    if (resumed === null) return
    const t = setTimeout(() => setResumed(null), 6000)
    return () => clearTimeout(t)
  }, [resumed])

  if (error) {
    return (
      <div className="viewer-error">
        <VideoOff size={40} strokeWidth={1.5} />
        <p>This video format can't be played here</p>
        <button className="btn" onClick={() => api.openExternal(item.id)}>
          <ExternalLink size={15} /> Open with default app
        </button>
      </div>
    )
  }

  return (
    <>
      <video
        ref={(el) => {
          videoRef.current = el
          if (el && !el.dataset.init) {
            el.dataset.init = '1'
            el.volume = Number(readPref('lumen.volume') ?? 1)
            el.muted = readPref('lumen.muted') === '1'
          }
        }}
        className="viewer-video"
        src={mediaUrl(item)}
        poster={thumbUrl(item)}
        controls
        autoPlay
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          onDims(v.videoWidth, v.videoHeight)
          if (!item.duration && Number.isFinite(v.duration)) api.reportDuration(item.id, v.duration)
          const at = resumePositions()[item.id]
          if (at && Number.isFinite(v.duration) && v.duration >= RESUME_MIN && at > 5 && at < v.duration - 5) {
            v.currentTime = at
            setResumed(at)
          }
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget
          if (!(v.duration >= RESUME_MIN) || Date.now() - lastSave.current < 2000) return
          lastSave.current = Date.now()
          saveResume(item.id, v.currentTime > 5 && v.currentTime < v.duration - 5 ? v.currentTime : null)
        }}
        onVolumeChange={(e) => {
          writePref('lumen.volume', String(e.currentTarget.volume))
          writePref('lumen.muted', e.currentTarget.muted ? '1' : '0')
        }}
        onEnded={() => {
          saveResume(item.id, null)
          onEnded()
        }}
        onError={() => setError(true)}
      />
      {resumed !== null && (
        <div className="resume-chip">
          Resumed at {formatDuration(resumed)}
          <button
            onClick={() => {
              if (videoRef.current) videoRef.current.currentTime = 0
              saveResume(item.id, null)
              setResumed(null)
            }}
          >
            Start over
          </button>
        </div>
      )}
    </>
  )
}

/** Videos this long or longer remember where you stopped watching. */
const RESUME_MIN = 30
const RESUME_KEY = 'lumen.resume'
const resumePositions = (): Record<string, number> => {
  try {
    return JSON.parse(readPref(RESUME_KEY) ?? '{}')
  } catch {
    return {}
  }
}
function saveResume(id: string, seconds: number | null) {
  const all = resumePositions()
  delete all[id]
  if (seconds !== null) all[id] = Math.round(seconds)
  const ids = Object.keys(all)
  for (const old of ids.slice(0, Math.max(0, ids.length - 300))) delete all[old] // keep the latest 300
  writePref(RESUME_KEY, JSON.stringify(all))
}

const FILM_SIZE = 52
const FILM_GAP = 6

function Filmstrip({
  items,
  index,
  onSelect,
  chromeProps,
}: {
  items: MediaItem[]
  index: number
  onSelect(i: number): void
  chromeProps: object
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { width } = useElementSize(ref)
  const [scrollLeft, setScrollLeft] = useState(0)
  const step = FILM_SIZE + FILM_GAP
  const pad = Math.max(0, (width - FILM_SIZE) / 2)

  useEffect(() => {
    const el = ref.current
    if (!el || !width) return
    const target = index * step
    const far = Math.abs(el.scrollLeft - target) > width * 2
    el.scrollTo({ left: target, behavior: far ? 'auto' : 'smooth' })
  }, [index, width, step])

  if (items.length < 2) return null
  const first = Math.max(0, Math.floor((scrollLeft - pad) / step) - 4)
  const last = Math.min(items.length - 1, Math.ceil((scrollLeft + width - pad) / step) + 4)
  const visible = []
  for (let i = first; i <= last; i++) visible.push(i)

  return (
    <div
      className="filmstrip chrome"
      ref={ref}
      onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      onWheel={(e) => {
        if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY
      }}
      {...chromeProps}
    >
      <div className="filmstrip-track" style={{ width: items.length * step - FILM_GAP + pad * 2 }}>
        {visible.map((i) => (
          <button
            key={items[i].id}
            className={`film-item${i === index ? ' active' : ''}`}
            style={{ left: pad + i * step }}
            onClick={() => onSelect(i)}
          >
            <img src={thumbUrl(items[i])} alt="" draggable={false} />
            {items[i].type === 'video' && <Play size={12} fill="currentColor" className="film-play" />}
          </button>
        ))}
      </div>
    </div>
  )
}
