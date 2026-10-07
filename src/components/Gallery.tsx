import { Check } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { api } from '../api'
import { useElementSize, useEvent } from '../hooks'
import { formatCount } from '../lib/format'
import { buildLayout, findRow, GRID_GAP, PAD_LEFT, PAD_RIGHT, rowOfIndex, type HeaderRow } from '../lib/layout'
import type { MediaItem } from '../types'
import { Scrubber } from './Scrubber'
import { Thumb } from './Thumb'

interface Props {
  items: MediaItem[]
  dateField: 'date' | 'added'
  thumbSize: number
  favorites: Set<string>
  selection: Set<string>
  /** Changing this scrolls back to the top (new view, search, filterâ€¦). */
  resetKey: string
  /** Each new object scrolls its item into view (e.g. after closing the viewer). */
  focus: { id: string } | null
  onOpen(index: number): void
  onSelect(index: number, mode: 'toggle' | 'range'): void
  onSelectRange(start: number, end: number, value: boolean): void
  onZoom(direction: 1 | -1): void
  /** Items about to be dragged (out to other apps, or onto an album in the sidebar). */
  onDragItems?(ids: string[]): void
  /** Live Photos: photo id → its motion clip. */
  live?: Map<string, MediaItem>
}

const OVERSCAN = 800
const FLING_PX_PER_MS = 2.5

export function Gallery(props: Props) {
  const { items, dateField, thumbSize, favorites, selection } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(scrollRef)
  const [scrollTop, setScrollTop] = useState(0)

  const layout = useMemo(
    () => buildLayout(items, dateField, Math.max(0, width - PAD_LEFT - PAD_RIGHT), thumbSize),
    [items, dateField, width, thumbSize],
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // Keep the first visible row anchored when the grid reflows (zoom / resize).
  const anchor = useRef<{ index: number; offset: number } | null>(null)
  const geometry = useRef({ width, thumbSize })
  useLayoutEffect(() => {
    const el = scrollRef.current
    const prev = geometry.current
    geometry.current = { width, thumbSize }
    if (!el || !anchor.current || (prev.width === width && prev.thumbSize === thumbSize)) return
    const row = rowOfIndex(layout, anchor.current.index)
    if (row) {
      el.scrollTop = Math.max(0, row.top - anchor.current.offset)
      setScrollTop(el.scrollTop)
    }
  }, [layout, width, thumbSize])

  const updateAnchor = (top: number) => {
    const { rows } = layoutRef.current
    if (!rows.length) return
    let i = findRow(rows, top)
    while (i < rows.length && rows[i].kind !== 'items') i++
    if (i < rows.length) anchor.current = { index: rows[i].start, offset: rows[i].top - top }
  }

  // While flinging or scrubbing, thumbnails flying past don't start loading — only where you land.
  const [flinging, setFlinging] = useState(false)
  const fling = useRef({ top: 0, t: 0, active: false, timer: 0 })
  const trackVelocity = (top: number) => {
    const f = fling.current
    const now = performance.now()
    const dt = now - f.t
    const velocity = Math.abs(top - f.top) / Math.max(1, dt)
    f.top = top
    f.t = now
    // A single jump (scrubber click, Home/End) loads right away; only sustained fast scrolling defers.
    if (dt > 100 || velocity < FLING_PX_PER_MS) return
    clearTimeout(f.timer)
    f.timer = window.setTimeout(() => {
      f.active = false
      setFlinging(false)
    }, 140)
    if (!f.active) {
      f.active = true
      setFlinging(true)
    }
  }

  const frame = useRef(0)
  const onScroll = () => {
    trackVelocity(scrollRef.current?.scrollTop ?? 0)
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const top = scrollRef.current?.scrollTop ?? 0
      setScrollTop(top)
      updateAnchor(top)
    })
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
    setScrollTop(0)
    anchor.current = null
  }, [props.resetKey])

  useEffect(() => {
    if (!props.focus) return
    const el = scrollRef.current
    const index = items.findIndex((it) => it.id === props.focus!.id)
    const row = index >= 0 ? rowOfIndex(layoutRef.current, index) : undefined
    if (!el || !row) return
    if (row.top < el.scrollTop + 60 || row.top + row.height > el.scrollTop + el.clientHeight) {
      el.scrollTop = row.top - (el.clientHeight - row.height) / 2
    }
  }, [props.focus])

  // Ctrl + wheel zooms the grid.
  const onZoom = useEvent(props.onZoom)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      onZoom(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoom])

  const selecting = selection.size > 0
  const onThumbClick = useEvent((e: MouseEvent, _item: MediaItem, index: number) => {
    if (e.shiftKey) props.onSelect(index, 'range')
    else if (e.ctrlKey || e.metaKey || selection.size > 0) props.onSelect(index, 'toggle')
    else props.onOpen(index)
  })
  const onThumbCheck = useEvent((e: MouseEvent, _item: MediaItem, index: number) =>
    props.onSelect(index, e.shiftKey ? 'range' : 'toggle'),
  )
  const targets = (item: MediaItem) => (selection.has(item.id) ? [...selection] : [item.id])
  const onThumbContext = useEvent((e: MouseEvent, item: MediaItem) => {
    e.preventDefault()
    api.showContextMenu(item.id, targets(item))
  })
  const onThumbDrag = useEvent((item: MediaItem) => {
    const ids = targets(item)
    props.onDragItems?.(ids)
    api.startDrag(ids)
  })

  const { rows, cell } = layout
  const first = rows.length ? findRow(rows, scrollTop - OVERSCAN) : 0
  const last = rows.length ? findRow(rows, scrollTop + height + OVERSCAN) : -1
  const visible = rows.slice(first, last + 1)

  const groupSelected = (h: HeaderRow) => {
    if (!selecting) return false
    for (let i = h.start; i < h.end; i++) if (!selection.has(items[i].id)) return false
    return true
  }

  const showScrubber = layout.total > height * 2.5

  return (
    <div className="gallery">
      <div
        ref={scrollRef}
        className={`gallery-scroll${showScrubber ? ' has-scrubber' : ''}`}
        onScroll={onScroll}
      >
        <div className="gallery-canvas" style={{ height: layout.total }}>
          {visible.map((row) => {
            if (row.kind === 'header') {
              const all = groupSelected(row)
              return (
                <div
                  key={row.key}
                  className={`group-header${selecting ? ' selecting' : ''}${all ? ' all' : ''}`}
                  style={{ top: row.top, height: row.height, left: PAD_LEFT, right: PAD_RIGHT }}
                >
                  <button
                    className="group-check"
                    onClick={() => props.onSelectRange(row.start, row.end, !all)}
                    aria-label="Select group"
                  >
                    <Check size={12} strokeWidth={3} />
                  </button>
                  <span className="group-label">{row.label}</span>
                  <span className="group-count">{formatCount(row.end - row.start)}</span>
                </div>
              )
            }
            const slice = items.slice(row.start, row.end)
            return (
              <div
                key={row.key}
                className="gallery-row"
                style={{ top: row.top, height: row.height, left: PAD_LEFT, right: PAD_RIGHT }}
              >
                {slice.map((item, i) => (
                  <Thumb
                    key={item.id}
                    item={item}
                    index={row.start + i}
                    x={i * (cell + GRID_GAP)}
                    size={cell}
                    selected={selection.has(item.id)}
                    selecting={selecting}
                    favorite={favorites.has(item.id)}
                    deferLoad={flinging}
                    live={props.live?.get(item.id)}
                    onClick={onThumbClick}
                    onCheck={onThumbCheck}
                    onContextMenu={onThumbContext}
                    onDragStart={onThumbDrag}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
      {showScrubber && (
        <Scrubber
          layout={layout}
          scrollTop={scrollTop}
          viewport={height}
          onSeek={(top) => {
            if (scrollRef.current) scrollRef.current.scrollTop = top
          }}
        />
      )}
    </div>
  )
}
