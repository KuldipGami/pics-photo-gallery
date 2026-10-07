import { Check, ChevronDown, ChevronUp, Merge, UserX } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useElementSize } from '../hooks'
import { formatCount } from '../lib/format'
import type { FaceRef, MediaItem, Person, PersonMatch } from '../types'
import { FaceAvatar } from './FaceAvatar'

const TILE = 116
const GAP = 12
const PAD_X = 28
const OVERSCAN_ROWS = 4

/**
 * Every face of one person, least similar first — wrong matches float to the top, so they can
 * be selected and moved/removed quickly. Virtualised: people can have thousands of faces.
 */
export function FacesGrid({
  faces,
  byId,
  selection,
  coverFace,
  onToggle,
  onOpen,
}: {
  faces: FaceRef[]
  byId: Map<string, MediaItem>
  selection: Set<string>
  coverFace: string
  onToggle(face: FaceRef, index: number, e: MouseEvent): void
  onOpen(face: FaceRef): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(ref)
  const [scrollTop, setScrollTop] = useState(0)
  const cols = Math.max(1, Math.floor((width - PAD_X * 2 + GAP) / (TILE + GAP)))
  const rows = Math.ceil(faces.length / cols)
  const rowH = TILE + GAP
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN_ROWS)
  const last = Math.min(rows - 1, Math.ceil((scrollTop + height) / rowH) + OVERSCAN_ROWS)
  const selecting = selection.size > 0

  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0
    setScrollTop(0)
  }, [faces.length === 0])

  const tiles = []
  for (let r = first; r <= last; r++) {
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c
      const face = faces[index]
      if (!face) break
      const selected = selection.has(face.faceId)
      tiles.push(
        <div
          key={face.faceId}
          className={`face-tile${selected ? ' selected' : ''}${selecting ? ' selecting' : ''}`}
          style={{ top: r * rowH, left: PAD_X + c * (TILE + GAP) }}
          onClick={(e) => (selecting || e.ctrlKey || e.shiftKey ? onToggle(face, index, e) : onOpen(face))}
          title={byId.get(face.item)?.name}
        >
          <FaceAvatar item={byId.get(face.item)} box={face.box} ar={face.ar} size={TILE} className="square" />
          {face.faceId === coverFace && <span className="face-cover-badge">Cover</span>}
          <button
            className="thumb-check"
            aria-label={selected ? 'Deselect' : 'Select'}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(face, index, e)
            }}
          >
            <Check size={13} strokeWidth={3} />
          </button>
        </div>,
      )
    }
  }

  return (
    <div className="faces-scroll" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div className="faces-hint">
        Least similar faces first — wrong matches usually show up at the top. Select them to move or remove them.
      </div>
      <div className="faces-canvas" style={{ height: rows * rowH + 40 }}>
        {tiles}
      </div>
    </div>
  )
}

/** Groups that look like this person: tick the ones that are, and merge them in one go. */
export function PossibleMatches({
  person,
  matches,
  peopleById,
  byId,
  onMerge,
  onNotSame,
}: {
  person: Person
  matches: PersonMatch[]
  peopleById: Map<string, Person>
  byId: Map<string, MediaItem>
  onMerge(ids: string[]): void
  onNotSame(ids: string[]): void
}) {
  const [open, setOpen] = useState(true)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const list = useMemo(() => matches.map((m) => peopleById.get(m.id)).filter((p): p is Person => !!p), [matches, peopleById])
  if (!list.length) return null

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const who = person.name || 'this person'
  const ids = [...picked].filter((id) => peopleById.has(id))

  return (
    <section className={`matches${open ? '' : ' collapsed'}`}>
      <div className="matches-head">
        <button className="matches-title" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          Possible matches <span className="matches-count">{formatCount(list.length)}</span>
        </button>
        {open && <span className="matches-sub">Select the groups that are also {who}</span>}
        <div className="spacer" />
        {open && ids.length > 0 && (
          <>
            <button className="btn ghost" onClick={() => (onNotSame(ids), setPicked(new Set()))}>
              <UserX size={15} /> Not {who}
            </button>
            <button className="btn primary" onClick={() => (onMerge(ids), setPicked(new Set()))}>
              <Merge size={15} /> Merge {formatCount(ids.length)} into {who}
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="matches-strip">
          {list.map((p) => (
            <button key={p.id} className={`match-card${picked.has(p.id) ? ' picked' : ''}`} onClick={() => toggle(p.id)}>
              <span className="match-avatar">
                <FaceAvatar item={byId.get(p.cover.item)} box={p.cover.box} ar={p.cover.ar} size={76} />
                <span className="match-check">
                  <Check size={13} strokeWidth={3} />
                </span>
              </span>
              <span className={`match-name${p.name ? '' : ' unnamed'}`}>{p.name || 'Unnamed'}</span>
              <span className="match-meta">{formatCount(p.count)} photos</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
