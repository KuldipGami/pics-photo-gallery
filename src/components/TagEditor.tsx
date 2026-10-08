import { Plus, Tag, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { fold } from '../lib/search'
import './tags.css'

export interface TagCount {
  tag: string
  count: number
}

interface Props {
  /** The tags of each selected item (a single list for one photo). */
  values: string[][]
  /** Tags used in the library, most used first (for suggestions and their spelling). */
  suggestions: TagCount[]
  /** Add these tags to every selected item. */
  onAdd(tags: string[]): void
  /** Remove this tag from every selected item. */
  onRemove(tag: string): void
  /** Light-on-dark colours, for the photo viewer. */
  dark?: boolean
  placeholder?: string
  autoFocus?: boolean
  /** The text box, e.g. to focus it from a keyboard shortcut. */
  inputRef?: Ref<HTMLInputElement>
  className?: string
}

const MAX_OPTIONS = 8
/** As stored (see electron/xmp.cjs cleanTag): no ";", single spaces, at most 64 characters. */
const clean = (t: string) => t.replace(/[;\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64).trim()

type Option = { kind: 'tag'; tag: string; count: number } | { kind: 'new'; tag: string }

/**
 * Tag chips with a text box that suggests existing tags. With several items selected, tags on
 * all of them are solid chips; tags on only some are dimmed (click one to add it to all).
 */
export function TagEditor({ values, suggestions, onAdd, onRemove, dark = false, placeholder, autoFocus, inputRef, className = '' }: Props) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [armed, setArmed] = useState<string | null>(null) // Backspace once arms the last chip, twice removes it
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const total = values.length

  // Chips: tags on every selected item first, then the ones only some have.
  const chips = useMemo(() => {
    const map = new Map<string, { tag: string; count: number }>()
    for (const list of values) {
      const seen = new Set<string>()
      for (const t of list) {
        const k = t.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k)
        const c = map.get(k)
        if (c) c.count++
        else map.set(k, { tag: t, count: 1 })
      }
    }
    const all = [...map.values()]
    return [...all.filter((c) => c.count === total), ...all.filter((c) => c.count < total)]
  }, [values, total])
  const onAll = useMemo(() => new Set(chips.filter((c) => c.count === total).map((c) => c.tag.toLowerCase())), [chips, total])

  const spelling = useMemo(() => new Map(suggestions.map((s) => [s.tag.toLowerCase(), s.tag])), [suggestions])

  const options = useMemo<Option[]>(() => {
    const q = fold(clean(text))
    const free = suggestions.filter((s) => !onAll.has(s.tag.toLowerCase()))
    if (!q) return free.slice(0, MAX_OPTIONS).map((s) => ({ kind: 'tag', ...s }))
    const starts: TagCount[] = []
    const contains: TagCount[] = []
    for (const s of free) {
      const f = fold(s.tag)
      if (f.startsWith(q) || f.split(/\s+/).some((w) => w.startsWith(q))) starts.push(s)
      else if (f.includes(q)) contains.push(s)
      if (starts.length >= MAX_OPTIONS) break
    }
    const list: Option[] = [...starts, ...contains].slice(0, MAX_OPTIONS).map((s) => ({ kind: 'tag', ...s }))
    const typed = clean(text)
    if (!spelling.has(typed.toLowerCase()) && !onAll.has(typed.toLowerCase())) list.push({ kind: 'new', tag: typed })
    return list
  }, [text, suggestions, onAll, spelling])

  useEffect(() => setActive(0), [text])
  const showMenu = open && options.length > 0

  useLayoutEffect(() => {
    if (!showMenu || !box.current) return setPos(null)
    const place = () => {
      const r = box.current!.getBoundingClientRect()
      const h = menu.current?.offsetHeight ?? 0
      const top = r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4
      setPos({ top, left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 8)), width: r.width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [showMenu, options.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!box.current?.contains(t) && !menu.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  /** Adds typed / picked tags, using the library's spelling for ones that already exist. */
  const commit = (raw: string[]) => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const r of raw) {
      const t = clean(r)
      const k = t.toLowerCase()
      if (!t || seen.has(k) || onAll.has(k)) continue
      seen.add(k)
      out.push(spelling.get(k) ?? t)
    }
    if (out.length) onAdd(out)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Backspace') setArmed(null)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return setOpen(true)
      const n = options.length
      if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Enter' || (e.key === 'Tab' && showMenu && text.trim())) {
      const pick = showMenu ? options[active] : null
      if (!pick && !text.trim()) return
      e.preventDefault()
      commit([pick ? pick.tag : text])
    } else if (e.key === 'Escape') {
      if (showMenu) {
        e.stopPropagation()
        setOpen(false)
      } else if (text) setText('')
      else e.currentTarget.blur()
    } else if (e.key === 'Backspace' && !text) {
      const last = [...chips].reverse().find((c) => c.count === total)
      if (!last) return
      if (armed === last.tag) {
        onRemove(last.tag)
        setArmed(null)
      } else setArmed(last.tag)
    }
  }

  const onChange = (value: string) => {
    setArmed(null)
    setOpen(true)
    // "," or ";" ends a tag (also when pasting "a, b; c")
    if (/[,;]/.test(value)) {
      const parts = value.split(/[,;]/)
      const rest = parts.pop() ?? ''
      commit(parts)
      setText(rest.trimStart())
    } else setText(value)
  }

  const q = fold(clean(text))
  const highlight = (tag: string) => {
    const i = q ? fold(tag).indexOf(q) : -1
    if (i < 0 || fold(tag).length !== tag.length) return tag
    return (
      <>
        {tag.slice(0, i)}
        <mark>{tag.slice(i, i + q.length)}</mark>
        {tag.slice(i + q.length)}
      </>
    )
  }

  return (
    <div
      ref={box}
      className={`tag-editor${dark ? ' dark' : ''}${className ? ` ${className}` : ''}`}
      onMouseDown={(e) => {
        if (e.target === box.current) {
          e.preventDefault()
          box.current?.querySelector('input')?.focus()
        }
      }}
    >
      {chips.map((c) => {
        const partial = c.count < total
        return (
          <span key={c.tag.toLowerCase()} className={`tag-chip${partial ? ' partial' : ''}${armed === c.tag ? ' armed' : ''}`}>
            {partial ? (
              <button
                type="button"
                className="tag-chip-label"
                title={`On ${c.count} of ${total} — click to add to all`}
                onClick={() => onAdd([c.tag])}
              >
                {c.tag}
              </button>
            ) : (
              <span className="tag-chip-label" title={c.tag}>
                {c.tag}
              </span>
            )}
            <button
              type="button"
              className="tag-chip-x"
              title={total > 1 ? `Remove “${c.tag}” from all ${total}` : `Remove “${c.tag}”`}
              aria-label={`Remove ${c.tag}`}
              onClick={() => onRemove(c.tag)}
            >
              <X size={12} strokeWidth={2.4} />
            </button>
          </span>
        )
      })}
      <input
        ref={inputRef}
        className="tag-input"
        value={text}
        placeholder={chips.length ? 'Add a tag' : placeholder ?? (total > 1 ? `Add a tag to ${total} items` : 'Add a tag')}
        autoFocus={autoFocus}
        spellCheck={false}
        role="combobox"
        aria-expanded={showMenu}
        aria-autocomplete="list"
        aria-label="Add a tag"
        onFocus={() => setOpen(true)}
        onBlur={() => setArmed(null)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {showMenu &&
        createPortal(
          <div
            ref={menu}
            className={`tag-suggest${dark ? ' dark' : ''}`}
            role="listbox"
            style={pos ? { top: pos.top, left: pos.left, minWidth: Math.max(200, Math.min(pos.width, 320)) } : { visibility: 'hidden' }}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the text box */}
          >
            {!q && <div className="tag-suggest-head">Most used</div>}
            {options.map((o, i) => (
              <button
                key={`${o.kind}:${o.tag}`}
                type="button"
                role="option"
                aria-selected={i === active}
                className={`tag-option${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit([o.tag])}
              >
                {o.kind === 'new' ? <Plus size={14} /> : <Tag size={14} />}
                <span className="tag-option-label">{o.kind === 'new' ? <>Add “{o.tag}”</> : highlight(o.tag)}</span>
                {o.kind === 'tag' && <span className="tag-option-count">{o.count.toLocaleString()}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
