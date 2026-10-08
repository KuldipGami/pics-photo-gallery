import { ListFilter, Search, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fold } from '../lib/search'
import { RatingStars } from './RatingStars'
import type { TagCount } from './TagEditor'
import './tags.css'

// ── data helpers (pure; usable anywhere in the renderer) ─────────────────────

/** What the main process sends (tags:changed / app:state): values set in Lumen, by item id. */
export interface TagsData {
  byItem: Record<string, { rating?: number; tags?: string[] }>
}

/** Anything with an id and the file's own values (MediaItem once it has rating?/tags?). */
export interface Markable {
  id: string
  rating?: number
  tags?: string[]
}

/** Gallery filter: minRating 0 = any, 1–5 = at least that many stars, −1 = unrated only. */
export interface RatingFilterValue {
  minRating: number
  /** Items must have every one of these tags (case-insensitive). */
  tags: string[]
}

export const NO_FILTER: RatingFilterValue = { minRating: 0, tags: [] }
const EMPTY: string[] = []

/** The rating and tags to show: Lumen's value when set, else the file's. */
export function marksOf(item: Markable, data?: TagsData | null): { rating: number; tags: string[] } {
  const own = data?.byItem[item.id]
  return { rating: own?.rating ?? item.rating ?? 0, tags: own?.tags ?? item.tags ?? EMPTY }
}

/** Every tag among `items` with how many have it, most used first. */
export function tagCounts(items: Markable[], data?: TagsData | null): TagCount[] {
  const map = new Map<string, TagCount>()
  for (const it of items) {
    for (const t of marksOf(it, data).tags) {
      const k = t.toLowerCase()
      const c = map.get(k)
      if (c) c.count++
      else map.set(k, { tag: t, count: 1 })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

export const filterActive = (f: RatingFilterValue) => f.minRating !== 0 || f.tags.length > 0

/** Does an item pass the gallery filter? */
export function matchesFilter(item: Markable, f: RatingFilterValue, data?: TagsData | null): boolean {
  if (!filterActive(f)) return true
  const { rating, tags } = marksOf(item, data)
  if (f.minRating < 0 ? rating > 0 : rating < f.minRating) return false
  if (!f.tags.length) return true
  const have = new Set(tags.map((t) => t.toLowerCase()))
  return f.tags.every((t) => have.has(t.toLowerCase()))
}

/** Folded text of an item's tags, for search ("beach" or "tag:beach"). */
export const tagText = (item: Markable, data?: TagsData | null) => fold(marksOf(item, data).tags.join(' | '))

// ── the header control ───────────────────────────────────────────────────────

interface Props {
  value: RatingFilterValue
  onChange(value: RatingFilterValue): void
  /** Tags to offer with their counts (e.g. among the items in the current view). */
  tags: TagCount[]
}

const ratingLabel = (n: number) => (n < 0 ? 'Unrated' : n === 5 ? '5 stars' : n > 0 ? `${n}+ stars` : 'Any rating')
const MANY_TAGS = 14

/** "Filter" button for the gallery header: minimum stars and tag chips, in a small panel. */
export function RatingFilter({ value, onChange, tags }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const active = filterActive(value)
  const chosen = useMemo(() => new Set(value.tags.map((t) => t.toLowerCase())), [value.tags])

  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return setPos(null)
    const a = anchor.current.getBoundingClientRect()
    const { offsetWidth: w, offsetHeight: h } = panel.current
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, a.right - w))
    let top = a.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8)
    setPos({ top, left })
  }, [open, tags.length, query])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!anchor.current?.contains(t) && !panel.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const close = () => setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const toggleTag = (tag: string) => {
    const k = tag.toLowerCase()
    onChange({ ...value, tags: chosen.has(k) ? value.tags.filter((t) => t.toLowerCase() !== k) : [...value.tags, tag] })
  }

  // Chosen tags stay listed even when nothing in view has them any more.
  const listed = useMemo(() => {
    const q = fold(query.trim())
    const known = new Set(tags.map((t) => t.tag.toLowerCase()))
    const all = [...value.tags.filter((t) => !known.has(t.toLowerCase())).map((tag) => ({ tag, count: 0 })), ...tags]
    return q ? all.filter((t) => fold(t.tag).includes(q)) : all
  }, [tags, value.tags, query])

  const summary = [value.minRating ? `${value.minRating < 0 ? 'Unrated' : `★ ${value.minRating}${value.minRating < 5 ? '+' : ''}`}` : '', ...value.tags]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="rating-filter" ref={anchor}>
      <button
        className={`btn ghost rating-filter-btn${active ? ' active' : ''}${open ? ' open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Filter by rating and tags"
        aria-expanded={open}
      >
        <ListFilter size={15} />
        <span className="rating-filter-summary">{active ? summary : 'Filter'}</span>
      </button>
      {active && (
        <button className="icon-btn tiny rating-filter-clear" onClick={() => onChange(NO_FILTER)} title="Clear the filter" aria-label="Clear the filter">
          <X size={13} />
        </button>
      )}
      {open &&
        createPortal(
          <div ref={panel} className="rating-filter-panel" style={pos ?? { visibility: 'hidden', top: 0, left: 0 }} role="dialog" aria-label="Filter">
            <div className="rf-section">
              <div className="rf-heading">
                <span>Rating</span>
                <span className="rf-hint">{ratingLabel(value.minRating)}</span>
              </div>
              <div className="rf-rating">
                <RatingStars
                  value={Math.max(0, value.minRating)}
                  onChange={(n) => onChange({ ...value, minRating: n })}
                  size={20}
                  label="Minimum rating"
                />
                <button className={`chip small${value.minRating < 0 ? ' active' : ''}`} onClick={() => onChange({ ...value, minRating: value.minRating < 0 ? 0 : -1 })}>
                  Unrated
                </button>
              </div>
            </div>
            <div className="rf-section">
              <div className="rf-heading">
                <span>Tags</span>
                {value.tags.length > 1 && <span className="rf-hint">Showing items with all of them</span>}
              </div>
              {tags.length + value.tags.length > MANY_TAGS && (
                <label className="rf-search">
                  <Search size={14} />
                  <input value={query} placeholder="Find a tag" onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
                </label>
              )}
              {listed.length ? (
                <div className="rf-tags">
                  {listed.map((t) => (
                    <button key={t.tag.toLowerCase()} className={`chip small${chosen.has(t.tag.toLowerCase()) ? ' active' : ''}`} onClick={() => toggleTag(t.tag)}>
                      {t.tag}
                      {t.count > 0 && <span className="chip-count">{t.count.toLocaleString()}</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rf-empty">{query ? 'No tag matches.' : 'No tags yet. Add some in a photo’s details (press I).'}</div>
              )}
            </div>
            {active && (
              <div className="rf-foot">
                <button className="btn ghost" onClick={() => onChange(NO_FILTER)}>
                  Clear filter
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
