import { useMemo, useRef, useState, type PointerEvent } from 'react'
import { formatShortMonth } from '../lib/format'
import { findRow, type GridLayout } from '../lib/layout'

interface Props {
  layout: GridLayout
  scrollTop: number
  viewport: number
  onSeek(top: number): void
}

const PAD = 14
const LABEL_GAP = 20

/** Google Photos–style timeline: year labels down the right edge, drag to jump through time. */
export function Scrubber({ layout, scrollTop, viewport, onSeek }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ y: number; label: string } | null>(null)
  const [dragging, setDragging] = useState(false)

  const track = Math.max(0, viewport - PAD * 2)
  const maxScroll = Math.max(1, layout.total - viewport)

  const marks = useMemo(() => {
    const years: { y: number; label: string }[] = []
    const dots: number[] = []
    let lastYear = NaN
    let lastMonth = NaN
    let lastLabelY = -Infinity
    for (const h of layout.headers) {
      const d = new Date(h.date)
      const y = Math.min(1, h.top / maxScroll) * track
      if (d.getFullYear() !== lastYear) {
        lastYear = d.getFullYear()
        lastMonth = d.getMonth()
        if (y - lastLabelY >= LABEL_GAP) {
          years.push({ y, label: String(lastYear) })
          lastLabelY = y
        }
      } else if (d.getMonth() !== lastMonth) {
        lastMonth = d.getMonth()
        if (y - lastLabelY > 8 && (!dots.length || y - dots[dots.length - 1] > 6)) dots.push(y)
      }
    }
    return { years, dots }
  }, [layout, maxScroll, track])

  if (layout.total < viewport * 2.5 || !layout.headers.length) return null

  const posFromEvent = (e: PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(track, e.clientY - rect.top - PAD))
  }
  const labelAt = (y: number) => {
    const top = (y / track) * maxScroll
    const h = layout.headers[findRow(layout.headers, top + 1)]
    return h ? formatShortMonth(h.date) : ''
  }
  const seek = (y: number) => onSeek((y / track) * maxScroll)

  const thumbY = Math.min(1, scrollTop / maxScroll) * track

  return (
    <div
      ref={ref}
      className={`scrubber${dragging ? ' dragging' : ''}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
        seek(posFromEvent(e))
      }}
      onPointerMove={(e) => {
        const y = posFromEvent(e)
        setHover({ y, label: labelAt(y) })
        if (dragging) seek(y)
      }}
      onPointerUp={() => setDragging(false)}
      onPointerLeave={() => !dragging && setHover(null)}
    >
      <div className="scrubber-track" style={{ top: PAD, height: track }}>
        {marks.dots.map((y, i) => (
          <span key={i} className="scrubber-dot" style={{ top: y }} />
        ))}
        {marks.years.map((m) => (
          <span key={m.label} className="scrubber-year" style={{ top: m.y }}>
            {m.label}
          </span>
        ))}
        <span className="scrubber-thumb" style={{ top: thumbY }} />
        {hover && (
          <span className="scrubber-hover" style={{ top: hover.y }}>
            <span className="scrubber-hover-label">{hover.label}</span>
          </span>
        )}
      </div>
    </div>
  )
}
