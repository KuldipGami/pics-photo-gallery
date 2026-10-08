import { ChevronLeft, ChevronRight, Columns2, ExternalLink, FolderOpen, Maximize2, Minus, Plus, ShieldCheck, SplitSquareHorizontal, Trash, X } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api, fullImageUrl, mediaUrl, thumbUrl } from '../api'
import { isLastCopy, kindText, matchText, needsReview, ruleMarks, type Facts } from '../lib/cleanup'
import { formatBytes, formatCount, formatDuration } from '../lib/format'
import type { DupGroup, KeepRule, MediaItem } from '../types'
import { SyncedVideos, type SyncedVideosHandle } from './SyncedVideos'

// Compare & review (ported from DupeLens): every copy side by side with zoom and pan shared by all
// of them, or two copies in a swipe view; keyboard-driven review of one group after another.

type View = { zoom: number; x: number; y: number }
const FIT: View = { zoom: 1, x: 0, y: 0 }
const MAX_ZOOM = 8
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const clampView = (v: View): View => {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom))
  const lim = (zoom - 1) / 2
  return { zoom, x: Math.min(lim, Math.max(-lim, v.x)), y: Math.min(lim, Math.max(-lim, v.y)) }
}

export type CompareSource = { mode: 'groups'; groups: DupGroup[]; index: number; focus?: string } | { mode: 'items'; items: MediaItem[]; index: number }

interface Props {
  source: CompareSource
  byId: Map<string, MediaItem>
  facts: Facts
  marks: Set<string>
  keepRule: KeepRule
  isProtected(id: string): boolean
  setMarks(update: (prev: Set<string>) => Set<string>): void
  /** A file's duplicate group (single files too can have copies elsewhere). */
  groupOf?(id: string): DupGroup | undefined
  /** The viewer is open on top ("View full screen"): its keys are its own. */
  paused?: boolean
  onClose(): void
  onFullScreen(ids: string[], index: number): void
  /** Recycle Bin for these files (asks first). */
  onRecycle?(ids: string[]): void
  onToast(text: string): void
}

/** Text boxes keep their keys; anything else (a slider, a select left focused behind) doesn't. */
const isTextInput = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit', 'color'].includes(el.type))

export function CompareView({ source, byId, facts, marks, keepRule, isProtected, setMarks, groupOf, paused, onClose, onFullScreen, onRecycle, onToast }: Props) {
  const [index, setIndex] = useState(source.index)
  const count = source.mode === 'groups' ? source.groups.length : source.items.length
  const group = source.mode === 'groups' ? source.groups[Math.min(index, count - 1)] : null
  const ids = group ? group.ids.filter((id) => byId.has(id)) : source.mode === 'items' ? [source.items[index]?.id].filter(Boolean) : []
  const [focus, setFocus] = useState(0)
  const [view, setView] = useState<View>(FIT)
  const [swipe, setSwipe] = useState(false)
  const [split, setSplit] = useState(0.5)
  const [right, setRight] = useState<number | null>(null)

  // this group's copies sent to the Recycle Bin (once they're gone, on to the next group)
  const [recycling, setRecycling] = useState<string[] | null>(null)

  // new group: fit, focus the clicked file (or the best copy)
  useEffect(() => {
    setView(FIT)
    setRight(null)
    setRecycling(null)
    const f = source.mode === 'groups' && index === source.index && source.focus ? ids.indexOf(source.focus) : -1
    setFocus(Math.max(0, f))
  }, [index])
  useEffect(() => {
    if (index >= count) (count ? setIndex(count - 1) : onClose())
  }, [count, index])
  useEffect(() => {
    if (!ids.length) onClose()
  }, [ids.length])

  const refIdx = group ? Math.max(0, ids.indexOf(group.ids[group.ref])) : 0
  const leftIdx = refIdx
  const rightIdx = right ?? (focus !== leftIdx ? focus : ids.findIndex((_, i) => i !== leftIdx))

  const present = (id: string) => byId.has(id)
  /** False when it can't be selected (protected, or the last copy left). */
  const setMark = (id: string, value: boolean) => {
    if (value && isProtected(id)) {
      onToast('Files in protected folders are always kept')
      return false
    }
    // never the last copy left unselected in its group (like the Select menu)
    const g = group ?? groupOf?.(id)
    if (value && g && isLastCopy(g, id, marks, present)) {
      onToast(LAST_COPY)
      return false
    }
    setMarks((prev) => {
      const next = new Set(prev)
      if (value) next.add(id)
      else next.delete(id)
      return next
    })
    return true
  }
  const keepOnly = (keep: string) =>
    setMarks((prev) => {
      const next = new Set(prev)
      for (const id of ids) if (id !== keep && !isProtected(id)) next.add(id)
      next.delete(keep)
      return next
    })
  const applyRule = () => {
    if (!group) return
    setMarks((prev) => {
      const next = new Set(prev)
      for (const id of group.ids) next.delete(id)
      for (const id of ruleMarks(group, keepRule, isProtected, present)) next.add(id)
      return next
    })
  }
  const go = (d: number) => setIndex((i) => Math.max(0, Math.min(count - 1, i + d)))
  const next = () => (index < count - 1 ? go(1) : onToast(source.mode === 'groups' ? 'That was the last group' : 'That was the last file'))

  // Recycle: just this group's selected copies, never every copy (the confirm comes from the app)
  const markedHere = group ? ids.filter((id) => marks.has(id)) : []
  const everyCopy = markedHere.length > 0 && markedHere.length === ids.length
  const recycle = () => {
    if (!onRecycle || !markedHere.length || everyCopy) return
    setRecycling(markedHere)
    onRecycle(markedHere)
  }
  useEffect(() => {
    if (!recycling || recycling.some((id) => byId.has(id))) return
    setRecycling(null)
    next()
  }, [byId, recycling])

  // ---------- keyboard (DupeLens' review keys) ----------
  const videoRef = useRef<SyncedVideosHandle>(null)
  // Many copies don't fit side by side: the columns scroll, and the chosen one comes into view.
  const colsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    colsRef.current?.querySelector(`[data-col="${focus}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [focus])
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    if (paused || e.ctrlKey || e.altKey || e.metaKey || isTextInput(e.target)) return
    const k = e.key
    const id = ids[focus]
    let handled = true
    if (k === 'Escape') onClose()
    else if (k === 'ArrowLeft') go(-1)
    else if ((k === ' ' || k === 'p' || k === 'P') && videoRef.current) videoRef.current.toggle()
    else if (k === 'ArrowRight' || k === ' ' || k === 'Enter') next()
    else if (k === 'ArrowUp') setFocus((f) => Math.max(0, f - 1))
    else if (k === 'ArrowDown' || k === 'Tab') setFocus((f) => (f + 1) % Math.max(1, ids.length))
    else if (/^[1-9]$/.test(k) && Number(k) <= ids.length) setFocus(Number(k) - 1)
    else if (k === 'k' || k === 'K') {
      if (!id) return
      if (group) keepOnly(id)
      else setMark(id, false)
      next()
    } else if (k === 'd' || k === 'D' || k === 'Delete') {
      if (!id) return
      const value = !marks.has(id)
      if (setMark(id, value) && !group && value) next()
    } else if ((k === 'a' || k === 'A') && group) applyRule()
    else if ((k === 's' || k === 'S') && ids.length >= 2) setSwipe((s) => !s)
    else if (k === 'f' || k === 'F' || k === '0') setView(FIT)
    else if (k === '+' || k === '=') setView((v) => clampView({ ...v, zoom: v.zoom * 1.5 }))
    else if (k === '-') setView((v) => clampView({ ...v, zoom: v.zoom / 1.5 }))
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [])
  // Focus moves in here, so a search box or select left focused behind doesn't keep the keys.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  }, [])
  /** Copies turned here: their button goes (the group's facts are from before the turn). */
  const [turned, setTurned] = useState<Set<string>>(() => new Set())

  const items = ids.map((id) => byId.get(id)!).filter(Boolean)
  const nMarked = ids.filter((id) => marks.has(id)).length
  const markedBytes = ids.reduce((s, id) => (marks.has(id) ? s + (byId.get(id)?.size ?? 0) : s), 0)
  const maxSharp = Math.max(0, ...ids.map((id) => facts[id]?.[0] ?? 0))
  const single = !group
  const summary = single
    ? marks.has(ids[0]) ? 'Selected for removal' : 'Not selected'
    : `${formatCount(ids.length)} files · ${nMarked ? `${formatCount(nMarked)} selected · ${formatBytes(markedBytes)}` : 'nothing selected'}`

  const pane = (i: number, extra?: { clip?: number }) => {
    const it = items[i]
    if (!it) return null
    return <Pane key={it.id + (extra?.clip !== undefined ? ':s' : '')} item={it} view={view} onView={setView} clip={extra?.clip} />
  }

  // Video groups play side by side on one clock (zoom doesn't apply there).
  const syncedVideos = !!group?.video && !swipe && items.length >= 2

  /** Number and KEEP / REMOVE badge, over a picture or a playing video. */
  const badges = (i: number) => {
    const id = items[i].id
    const prot = isProtected(id)
    const marked = marks.has(id)
    return (
      <>
        {!single && <span className={`compare-num${i === focus ? ' on' : ''}`}>{i + 1}</span>}
        {prot ? (
          <span className="ctile-badge protected">
            <ShieldCheck size={12} /> PROTECTED
          </span>
        ) : (
          <span className={`ctile-badge ${marked ? 'remove' : 'keep'}`}>{marked ? 'REMOVE' : 'KEEP'}</span>
        )}
      </>
    )
  }

  /** Name, match, facts and actions under each copy. */
  const info = (i: number) => {
    const it = items[i]
    const id = it.id
    const prot = isProtected(id)
    const marked = marks.has(id)
    const f = facts[id]
    return (
      <div className="compare-info" onClick={() => setFocus(i)}>
        <div className="compare-name" title={it.path}>
          {it.name}
        </div>
        {group && <div className={`compare-match${i === refIdx ? ' ref' : ''}`}>{matchText(group, group.ids.indexOf(id))}{group.sharpest === group.ids.indexOf(id) ? ' · Sharpest' : ''}</div>}
        <table>
          <tbody>
            <tr>
              <th>Resolution</th>
              <td>{f && f[3] ? `${f[3]} × ${f[4]}` : '—'}</td>
            </tr>
            <tr>
              <th>File size</th>
              <td>{formatBytes(it.size)}</td>
            </tr>
            {it.type === 'video' ? (
              <tr>
                <th>Duration</th>
                <td>{formatDuration(it.duration) || '—'}</td>
              </tr>
            ) : (
              <tr>
                <th>Sharpness</th>
                <td>{f && f[0] > 0 && maxSharp > 0 ? `${Math.round((f[0] / maxSharp) * 100)}%` : '—'}</td>
              </tr>
            )}
            <tr>
              <th>Date taken</th>
              <td>{it.taken ? dateTimeFmt.format(it.taken) : '—'}</td>
            </tr>
            <tr>
              <th>Modified</th>
              <td>{dateTimeFmt.format(it.mtime)}</td>
            </tr>
            <tr>
              <th>Location</th>
              <td className="compare-dir">
                <button className="link" title="Show it in its folder" onClick={() => api.reveal(id)}>
                  {it.path}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div className="compare-actions">
          {prot ? (
            <span className="compare-prot">
              <ShieldCheck size={14} /> Protected folder: always kept
            </span>
          ) : (
            <label className="compare-switch" onClick={(e) => e.stopPropagation()}>
              <button role="switch" aria-checked={marked} className={`switch danger${marked ? ' on' : ''}`} onClick={() => setMark(id, !marked)}>
                <span />
              </button>
              Remove this file
            </label>
          )}
          <div className="spacer" />
          {group && !turned.has(id) && turnToMatch(group, group.ids.indexOf(id), it) > 0 && (
            <button
              className="btn ghost"
              title="Turn this copy the same way as the best copy (lossless: only the orientation tag changes)"
              onClick={async () => {
                const turns = turnToMatch(group, group.ids.indexOf(id), it)
                setTurned((t) => new Set(t).add(id)) // one click, one turn
                const res = await api.rotateLossless([id], turns)
                if (!res.done)
                  setTurned((t) => {
                    const next = new Set(t)
                    next.delete(id)
                    return next
                  })
                onToast(res.done ? `Turned ${it.name}. Undo it from History if needed.` : `Couldn't turn ${it.name}: ${res.errors[0] ?? ''}`)
              }}
            >
              {['', 'Turn right', 'Turn upside down', 'Turn left'][turnToMatch(group, group.ids.indexOf(id), it)]}
            </button>
          )}
          <button className="icon-btn" onClick={() => api.openExternal(id)} title="Open with default app">
            <ExternalLink size={15} />
          </button>
          <button className="icon-btn" onClick={() => api.reveal(id)} title="Show in folder">
            <FolderOpen size={15} />
          </button>
          {group && (
            <button className="link" onClick={() => keepOnly(id)}>
              Keep only this
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="compare" role="dialog" aria-label="Compare" ref={rootRef} tabIndex={-1}>
      <div className="compare-head">
        <span className={`kind-pill${group?.exact ? ' exact' : group && needsReview(group) ? ' review' : ''}`}>
          {group ? kindText(group) : items[0]?.ext.toUpperCase()}
        </span>
        <div className="compare-title">
          <b>{group ? `Group ${group.n}${group.video ? ' · videos' : ''}` : items[0]?.name}</b>
          <span>{summary}</span>
        </div>
        <div className="spacer" />
        {ids.length >= 2 && (
          <div className="segmented small">
            <button className={!swipe ? 'active' : ''} onClick={() => setSwipe(false)}>
              <Columns2 size={14} /> Side by side
            </button>
            <button className={swipe ? 'active' : ''} onClick={() => setSwipe(true)} title="Swipe between two copies (S)">
              <SplitSquareHorizontal size={14} /> Swipe
            </button>
          </div>
        )}
        <div className="compare-zoom" hidden={syncedVideos}>
          <button className="icon-btn" onClick={() => setView((v) => clampView({ ...v, zoom: v.zoom / 1.5 }))} title="Zoom out (−)">
            <Minus size={16} />
          </button>
          <span>{Math.round(view.zoom * 100)}%</span>
          <button className="icon-btn" onClick={() => setView((v) => clampView({ ...v, zoom: v.zoom * 1.5 }))} title="Zoom in (+)">
            <Plus size={16} />
          </button>
          <button className="btn ghost" onClick={() => setView(FIT)} title="Fit (F)">
            Fit
          </button>
        </div>
        {group && onRecycle && (
          <button
            className="btn danger"
            disabled={!markedHere.length || everyCopy}
            onClick={recycle}
            title={
              everyCopy
                ? 'Every copy is selected: unselect the one to keep first'
                : markedHere.length
                  ? `Move the ${markedHere.length === 1 ? 'selected copy' : `${formatCount(markedHere.length)} selected copies`} of this group to the Recycle Bin`
                  : 'Select the copies to remove first (D, or A for auto)'
            }
          >
            <Trash size={15} /> {markedHere.length && !everyCopy ? `Recycle ${formatCount(markedHere.length)}` : 'Recycle'}
          </button>
        )}
        <button className="icon-btn" onClick={() => onFullScreen(ids, focus)} title="View full screen">
          <Maximize2 size={17} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          <X size={18} />
        </button>
      </div>

      {swipe && ids.length >= 2 ? (
        <div className="compare-swipe">
          <div className="swipe-stage">
            {pane(leftIdx)}
            {pane(rightIdx, { clip: split })}
            <div className="swipe-line" style={{ left: `${split * 100}%` }} />
            <span className="swipe-label left">◀ {items[leftIdx]?.name}</span>
            <span className="swipe-label right">{items[rightIdx]?.name} ▶</span>
          </div>
          <div className="swipe-controls">
            <input type="range" min={0} max={1} step={0.02} value={split} onChange={(e) => setSplit(Number(e.target.value))} />
            <span>Compare with</span>
            {items.map((it, i) =>
              i === leftIdx ? null : (
                <button key={it.id} className={`chip${i === rightIdx ? ' active' : ''}`} onClick={() => setRight(i)}>
                  {i + 1}
                </button>
              ),
            )}
          </div>
        </div>
      ) : syncedVideos ? (
        <SyncedVideos
          ref={videoRef}
          items={items}
          offsets={ids.map((id) => group.offsets?.[group.ids.indexOf(id)] ?? 0)}
          refIndex={refIdx}
          overlay={badges}
          footer={info}
          onSelect={setFocus}
        />
      ) : (
        <div className="compare-cols" ref={colsRef} style={{ gridTemplateColumns: `repeat(${items.length}, minmax(${items.length > 3 ? 340 : 0}px, 1fr))` }}>
          {items.map((it, i) => (
            <div key={it.id} data-col={i} className={`compare-col${i === focus ? ' focused' : ''}${marks.has(it.id) ? ' marked' : ''}`}>
              <div className="compare-stage">
                {pane(i)}
                {badges(i)}
              </div>
              {info(i)}
            </div>
          ))}
        </div>
      )}

      <div className="compare-foot">
        <button className="btn ghost" disabled={index === 0} onClick={() => go(-1)}>
          <ChevronLeft size={16} /> Previous
        </button>
        <span className="compare-pos">
          {formatCount(index + 1)} of {formatCount(count)}
        </span>
        <button className="btn ghost" disabled={index >= count - 1} onClick={() => go(1)}>
          Next <ChevronRight size={16} />
        </button>
        <div className="spacer" />
        <div className="compare-keys">
          {(single
            ? [['K', 'keep'], ['D', 'remove'], ['Space', 'next'], ['Wheel', 'zoom']]
            : group?.video && !swipe
              ? [['1–9', 'choose'], ['K', 'keep only'], ['D', 'toggle remove'], ['A', 'auto'], ['Space', 'play / pause'], ['→', 'next']]
              : [['1–9', 'choose'], ['K', 'keep only'], ['D', 'toggle remove'], ['A', 'auto'], ['S', 'swipe'], ['Space', 'next'], ['Wheel', 'zoom']]
          ).map(([k, label]) => (
            <span key={k}>
              <kbd>{k}</kbd> {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

const LAST_COPY = 'Every other copy is selected already, so this one is kept. Unselect another copy first to keep that one instead.'

const JPEG = new Set(['jpg', 'jpeg', 'jpe', 'jfif'])
/** Clockwise quarter turns that make a rotated JPEG copy match its group's best copy (0 = none). */
export function turnToMatch(g: DupGroup, i: number, it: MediaItem) {
  const info = g.info[i]
  return it.type === 'image' && JPEG.has(it.ext) && info && info[1] === 'rotated' && typeof info[2] === 'number' ? info[2] : 0
}

/** One picture (or video) whose zoom & pan follow the shared view. */
function Pane({ item, view, onView, clip }: { item: MediaItem; view: View; onView(update: (v: View) => View): void; clip?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  const at = (clientX: number, clientY: number) => {
    const r = ref.current!.getBoundingClientRect()
    return { u: (clientX - r.left) / r.width - 0.5, v: (clientY - r.top) / r.height - 0.5 }
  }
  const zoomAround = (factor: number, clientX: number, clientY: number) => {
    const { u, v } = at(clientX, clientY)
    onView((cur) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(1, cur.zoom * factor))
      // keep the point under the cursor where it is
      const px = (u - cur.x) / cur.zoom
      const py = (v - cur.y) / cur.zoom
      return clampView({ zoom, x: u - px * zoom, y: v - py * zoom })
    })
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAround(e.deltaY < 0 ? 1.25 : 1 / 1.25, e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const onDown = (e: ReactPointerEvent) => {
    if (view.zoom <= 1 || item.type === 'video') return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
  }
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    onView((cur) => clampView({ ...cur, x: d.vx + (e.clientX - d.x) / r.width, y: d.vy + (e.clientY - d.y) / r.height }))
  }

  const style = { transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.zoom})` }
  return (
    <div
      ref={ref}
      className={`pane${view.zoom > 1 ? ' zoomed' : ''}`}
      style={clip !== undefined ? { clipPath: `inset(0 0 0 ${clip * 100}%)` } : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={(e) => (view.zoom > 1.01 ? onView(() => FIT) : zoomAround(2.5, e.clientX, e.clientY))}
    >
      <div className="pane-inner" style={style}>
        {item.type === 'video' ? (
          <video src={mediaUrl(item)} poster={thumbUrl(item)} controls playsInline muted />
        ) : (
          <>
            {!loaded && <img src={thumbUrl(item)} alt="" draggable={false} />}
            <img src={fullImageUrl(item)} alt="" draggable={false} onLoad={() => setLoaded(true)} style={loaded ? undefined : { position: 'absolute', opacity: 0 }} />
          </>
        )}
      </div>
    </div>
  )
}
