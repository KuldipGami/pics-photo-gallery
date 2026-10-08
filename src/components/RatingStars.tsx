import { Star } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import './tags.css'

interface Props {
  /** 0–5 (0 = not rated). */
  value: number
  /** Leave out for a read-only display. Clicking the current rating clears it. */
  onChange?(value: number): void
  /** Selected items have different ratings: no stars show until one is picked. */
  mixed?: boolean
  /** Star size in px. */
  size?: number
  /** Light-on-dark colours, for the photo viewer. */
  dark?: boolean
  /** Read-only and only the filled stars (thumbnails, lists); renders nothing when unrated. */
  compact?: boolean
  label?: string
  className?: string
}

const clamp = (n: number) => Math.max(0, Math.min(5, Math.round(n) || 0))
const starsText = (n: number) => (n ? `${n} star${n === 1 ? '' : 's'}` : 'Not rated')

/** Star rating: hover to preview, click to set, keys 0–5 / arrows when focused. */
export function RatingStars({ value, onChange, mixed = false, size = 16, dark = false, compact = false, label = 'Rating', className = '' }: Props) {
  const [hover, setHover] = useState(0)
  const v = clamp(value)
  const cls = `rating-stars${dark ? ' dark' : ''}${className ? ` ${className}` : ''}`

  if (!onChange) {
    if (compact && !v) return null
    return (
      <span className={`${cls} readonly`} role="img" aria-label={`${label}: ${starsText(v)}`} title={starsText(v)}>
        {Array.from({ length: compact ? v : 5 }, (_, i) => (
          <span key={i} className={`rating-star${i < v ? ' on' : ''}`}>
            <Star size={size} fill={i < v ? 'currentColor' : 'none'} strokeWidth={1.8} />
          </span>
        ))}
      </span>
    )
  }

  const shown = hover || (mixed ? 0 : v)
  const pick = (n: number) => onChange(n === v && !mixed ? 0 : n)
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    let next: number | null = null
    if (/^[0-5]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) next = Number(e.key)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(5, v + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, v - 1)
    else if (e.key === 'Home' || e.key === 'Backspace' || e.key === 'Delete') next = 0
    else if (e.key === 'End') next = 5
    if (next === null) return
    // Handled here: the viewer / gallery shortcuts (0 = reset zoom, arrows = next photo) must not fire too.
    e.preventDefault()
    e.stopPropagation()
    if (next !== v || mixed) onChange(next)
  }

  return (
    <span
      className={`${cls} editable${hover ? ' hovering' : ''}${mixed ? ' mixed' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={v}
      aria-valuetext={mixed ? 'Mixed' : starsText(v)}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHover(0)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`rating-star${n <= shown ? ' on' : ''}`}
          onMouseEnter={() => setHover(n)}
          onClick={() => pick(n)}
          title={n === v && !mixed ? `${starsText(n)} — click to clear` : starsText(n)}
        >
          <Star size={size} fill={n <= shown ? 'currentColor' : 'none'} strokeWidth={1.8} />
        </span>
      ))}
    </span>
  )
}
