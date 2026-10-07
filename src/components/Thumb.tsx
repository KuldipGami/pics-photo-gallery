import { Check, Heart, ImageOff, Play } from 'lucide-react'
import { memo, useState, type MouseEvent } from 'react'
import { thumbUrl } from '../api'
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

  const cls = ['thumb', loaded && 'loaded', seen && 'instant', selected && 'selected', selecting && 'selecting']
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cls}
      style={{ left: x, width: size, height: size }}
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
        <div className="thumb-shade" />
        {item.type === 'video' && (
          <span className="thumb-video">
            <Play size={11} fill="currentColor" />
            {formatDuration(item.duration)}
          </span>
        )}
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
