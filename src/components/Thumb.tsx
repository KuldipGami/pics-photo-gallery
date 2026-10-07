import { Check, Heart, ImageOff, Play } from 'lucide-react'
import { memo, useEffect, useRef, useState, type MouseEvent } from 'react'
import { mediaUrl, thumbUrl } from '../api'
import { formatDuration } from '../lib/format'
import type { MediaItem } from '../types'

/** Thumbnails already decoded once: shown instantly (no fade, no deferral) when scrolled back to. */
const shown = new Set<string>()

interface Props {
  item: MediaItem
  index: number
  x: number
  size: number
  selected: boolean
  selecting: boolean
  favorite: boolean
  /** True while the grid is being flung / scrubbed: don't start new loads yet. */
  deferLoad: boolean
  /** The motion clip of a Live Photo. */
  live?: MediaItem
  onClick(e: MouseEvent, item: MediaItem, index: number): void
  onCheck(e: MouseEvent, item: MediaItem, index: number): void
  onContextMenu(e: MouseEvent, item: MediaItem): void
  onDragStart(item: MediaItem): void
}

export const Thumb = memo(function Thumb(props: Props) {
  const { item, index, x, size, selected, selecting, favorite } = props
  const src = thumbUrl(item)
  const seen = shown.has(src)
  const [loaded, setLoaded] = useState(seen)
  const [failed, setFailed] = useState(false)
  // Latches on: once a load has started it isn't cancelled by a later fling.
  const [started, setStarted] = useState(seen)
  if (!started && !props.deferLoad) setStarted(true)

  // Hover a video (or Live Photo) for a moment to play a silent preview in place.
  const clip = item.type === 'video' ? item : props.live
  const [previewing, setPreviewing] = useState(false)
  const hoverTimer = useRef(0)
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  useEffect(() => {
    if (props.deferLoad || selecting) setPreviewing(false)
  }, [props.deferLoad, selecting])

  const cls = ['thumb', loaded && 'loaded', seen && 'instant', selected && 'selected', selecting && 'selecting']
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cls}
      style={{ left: x, width: size, height: size }}
      onMouseEnter={() => {
        if (!clip || selecting || props.deferLoad) return
        hoverTimer.current = window.setTimeout(() => setPreviewing(true), item.type === 'video' ? 450 : 250)
      }}
      onMouseLeave={() => {
        clearTimeout(hoverTimer.current)
        setPreviewing(false)
      }}
      onClick={(e) => props.onClick(e, item, index)}
      onContextMenu={(e) => props.onContextMenu(e, item)}
      draggable
      onDragStart={(e) => {
        e.preventDefault()
        props.onDragStart(item)
      }}
      data-id={item.id}
      title={item.name}
    >
      <div className="thumb-inner">
        {failed ? (
          <div className="thumb-fallback">
            <ImageOff size={22} />
            <span>{item.ext.toUpperCase()}</span>
          </div>
        ) : (
          started && (
            <img
              src={src}
              alt=""
              decoding="async"
              draggable={false}
              onLoad={() => {
                shown.add(src)
                setLoaded(true)
              }}
              onError={() => setFailed(true)}
            />
          )
        )}
        {previewing && clip && (
          <video
            className="thumb-preview"
            src={mediaUrl(clip)}
            muted
            autoPlay
            loop
            playsInline
            disablePictureInPicture
            onLoadedMetadata={(e) => {
              // long videos: skip the intro
              const v = e.currentTarget
              if (v.duration > 30) v.currentTime = v.duration * 0.1
            }}
            onError={() => setPreviewing(false)}
          />
        )}
        <div className="thumb-shade" />
        {item.type === 'video' && (
          <span className="thumb-video">
            <Play size={11} fill="currentColor" />
            {formatDuration(item.duration)}
          </span>
        )}
        {props.live && <span className="thumb-live">LIVE</span>}
        {favorite && <Heart className="thumb-fav" size={15} fill="currentColor" />}
      </div>
      <button
        className="thumb-check"
        aria-label={selected ? 'Deselect' : 'Select'}
        onClick={(e) => {
          e.stopPropagation()
          props.onCheck(e, item, index)
        }}
      >
        <Check size={13} strokeWidth={3} />
      </button>
    </div>
  )
})
