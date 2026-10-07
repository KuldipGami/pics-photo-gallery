import { ExternalLink, ImageOff } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { api, fullImageUrl, thumbUrl } from '../api'
import { useElementSize } from '../hooks'
import type { FaceBox, MediaItem } from '../types'

export interface ZoomControls {
  zoom(factor: number): void
  reset(): void
}

interface Props {
  item: MediaItem
  controls: RefObject<ZoomControls | null>
  onDims(w: number, h: number): void
  /** Reports zoom as a fraction of the image's actual pixel size. */
  onZoom(actual: number, zoomed: boolean): void
  /** Outline one face (normalised box), e.g. while hovering its chip in the details panel. */
  highlight?: FaceBox | null
}

export function ZoomableImage({ item, controls, onDims, onZoom, highlight }: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(stageRef)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [error, setError] = useState(false)
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  const fit = natural && size.width ? Math.min(size.width / natural.w, size.height / natural.h, 1) : 1
  const baseW = natural ? natural.w * fit : 0
  const baseH = natural ? natural.h * fit : 0
  const maxScale = Math.max(2, (1 / fit) * 4)

  const geo = useRef({ baseW, baseH, size, maxScale, t })
  geo.current = { baseW, baseH, size, maxScale, t }

  const clamp = (s: number, x: number, y: number) => {
    const g = geo.current
    const mx = Math.max(0, (g.baseW * s - g.size.width) / 2)
    const my = Math.max(0, (g.baseH * s - g.size.height) / 2)
    return { s, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) }
  }

  const zoomTo = (target: number, px = 0, py = 0) => {
    const g = geo.current
    const s = Math.max(1, Math.min(g.maxScale, target))
    const k = s / g.t.s
    setT(clamp(s, px - (px - g.t.x) * k, py - (py - g.t.y) * k))
  }

  const pointOf = (clientX: number, clientY: number): [number, number] => {
    const r = stageRef.current!.getBoundingClientRect()
    return [clientX - r.left - r.width / 2, clientY - r.top - r.height / 2]
  }

  useEffect(() => {
    controls.current = { zoom: (f) => zoomTo(geo.current.t.s * f), reset: () => zoomTo(1) }
  })

  useEffect(() => onZoom(t.s * fit, t.s > 1.001), [t.s, fit, onZoom])
  useEffect(() => setT((cur) => clamp(cur.s, cur.x, cur.y)), [size.width, size.height])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))
      zoomTo(geo.current.t.s * factor, ...pointOf(e.clientX, e.clientY))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  if (error) {
    return (
      <div className="viewer-error">
        <ImageOff size={40} strokeWidth={1.5} />
        <p>This file can't be previewed</p>
        <button className="btn" onClick={() => api.openExternal(item.id)}>
          <ExternalLink size={15} /> Open with default app
        </button>
      </div>
    )
  }

  return (
    <div
      ref={stageRef}
      className={`zoom-stage${t.s > 1.001 ? ' zoomed' : ''}${dragging ? ' dragging' : ''}`}
      onDoubleClick={(e) => {
        if (t.s > 1.001) zoomTo(1)
        else zoomTo(Math.max(2, 1 / fit), ...pointOf(e.clientX, e.clientY))
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || t.s <= 1.001) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { px: e.clientX, py: e.clientY, x: t.x, y: t.y }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) setT(clamp(t.s, d.x + e.clientX - d.px, d.y + e.clientY - d.py))
      }}
      onPointerUp={() => {
        drag.current = null
        setDragging(false)
      }}
    >
      {!natural && <img className="zoom-placeholder" src={thumbUrl(item)} alt="" draggable={false} />}
      <div
        className="zoom-layer"
        style={
          natural
            ? {
                width: baseW,
                height: baseH,
                transform: `translate(-50%, -50%) translate(${t.x}px, ${t.y}px) scale(${t.s})`,
              }
            : { opacity: 0, transform: 'translate(-50%, -50%)' }
        }
      >
        <img
          className="zoom-image"
          src={fullImageUrl(item)}
          alt={item.name}
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget
            setNatural({ w, h })
            onDims(w, h)
          }}
          onError={() => setError(true)}
        />
        {natural && highlight && (
          <div
            className="face-highlight"
            style={{
              left: `${highlight[0] * 100}%`,
              top: `${highlight[1] * 100}%`,
              width: `${highlight[2] * 100}%`,
              height: `${highlight[3] * 100}%`,
            }}
          />
        )}
      </div>
    </div>
  )
}
