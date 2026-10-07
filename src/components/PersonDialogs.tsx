import { ArrowRight, Check, Pencil, Search, UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatCount } from '../lib/format'
import type { FaceRef, MediaItem, PairSuggestion, Person } from '../types'
import { FaceAvatar } from './FaceAvatar'

/** The person's name in the header; click to edit, Enter to save, Esc to cancel. */
export function PersonName({ person, onRename }: { person: Person; onRename(name: string): void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(person.name)
  useEffect(() => {
    if (!editing) setValue(person.name)
  }, [person.name, editing])

  if (!editing) {
    return (
      <button className={`person-title${person.name ? '' : ' unnamed'}`} onClick={() => setEditing(true)} title="Rename">
        <h1>{person.name || 'Add a name'}</h1>
        <Pencil size={15} />
      </button>
    )
  }
  const commit = () => {
    setEditing(false)
    if (value.trim() !== person.name) onRename(value.trim())
  }
  return (
    <div className="person-title-edit">
      <input
        autoFocus
        value={value}
        placeholder="Who is this?"
        maxLength={60}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setValue(person.name)
            setEditing(false)
          }
        }}
      />
      <button className="icon-btn" onMouseDown={(e) => e.preventDefault()} onClick={commit} title="Save">
        <Check size={18} />
      </button>
    </div>
  )
}

/**
 * Handles keys for a dialog and stops them reaching grid/viewer shortcuts. Keys typed into the
 * dialog's own text fields still reach those fields (the app's shortcuts ignore inputs anyway).
 */
export function useDialogKeys(onKey: (e: KeyboardEvent) => void) {
  const ref = useRef(onKey)
  ref.current = onKey
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea')
      if (!typing) e.stopPropagation()
      ref.current(e)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])
}

const sortPeople = (a: Person, b: Person) => Number(!!b.name) - Number(!!a.name) || b.count - a.count
const LIST_LIMIT = 80

/** Pick an existing person — or create a new one — e.g. for "Move to…", "Merge into…", "Who's this?". */
export function PersonPicker({
  title,
  description,
  people,
  byId,
  exclude,
  allowNew = true,
  onPick,
  onClose,
}: {
  title: string
  description?: string
  people: Person[]
  byId: Map<string, MediaItem>
  exclude?: Set<string>
  allowNew?: boolean
  onPick(target: Person | { name: string }): void
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const list = useMemo(
    () =>
      people
        .filter((p) => !exclude?.has(p.id) && (!q || p.name.toLowerCase().includes(q)))
        .sort(sortPeople),
    [people, exclude, q],
  )

  useEffect(() => inputRef.current?.focus(), [])
  useDialogKeys((e) => {
    if (e.key === 'Escape') onClose()
  })

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal picker-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="merge-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {description && <p>{description}</p>}
        <div className="merge-search">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder={allowNew ? 'Search by name, or type a new name' : 'Search by name'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && allowNew && query.trim() && !list.some((p) => p.name.toLowerCase() === q)) {
                onPick({ name: query.trim() })
              }
            }}
          />
        </div>
        <div className="merge-list">
          {allowNew && (
            <button className="merge-row new-person" onClick={() => onPick({ name: query.trim() })}>
              <span className="new-person-icon">
                <UserPlus size={18} />
              </span>
              <span>{query.trim() ? `New person “${query.trim()}”` : 'New person'}</span>
            </button>
          )}
          {list.slice(0, LIST_LIMIT).map((p) => (
            <button key={p.id} className="merge-row" onClick={() => onPick(p)}>
              <FaceAvatar item={byId.get(p.cover.item)} box={p.cover.box} ar={p.cover.ar} size={40} />
              <span className={p.name ? '' : 'unnamed'}>{p.name || 'Unnamed person'}</span>
              <span className="merge-count">{formatCount(p.count)}</span>
            </button>
          ))}
          {list.length > LIST_LIMIT && (
            <div className="merge-empty">{formatCount(list.length - LIST_LIMIT)} more — type a name to find them.</div>
          )}
          {!list.length && !allowNew && <div className="merge-empty">No people match.</div>}
        </div>
      </div>
    </div>
  )
}

function PersonColumn({
  person,
  faces,
  byId,
}: {
  person: Person
  faces: FaceRef[]
  byId: Map<string, MediaItem>
}) {
  // the most typical faces show who this group really is
  const samples = useMemo(() => [...faces].sort((a, b) => a.dist - b.dist).slice(0, 4), [faces])
  return (
    <div className="review-person">
      <FaceAvatar item={byId.get(person.cover.item)} box={person.cover.box} ar={person.cover.ar} size={120} />
      <div className={`person-name${person.name ? '' : ' unnamed'}`}>{person.name || 'Unnamed person'}</div>
      <div className="person-meta">
        {formatCount(person.count)} photo{person.count === 1 ? '' : 's'}
      </div>
      <div className="review-samples">
        {samples.map((f) => (
          <FaceAvatar key={f.faceId} item={byId.get(f.item)} box={f.box} ar={f.ar} size={52} className="square" />
        ))}
      </div>
    </div>
  )
}

/** "Same person?" — step through likely duplicate groups. Y = same, N = different, S/→ = skip. */
export function SuggestionsReview({
  pairs,
  peopleById,
  facesByPerson,
  byId,
  onSame,
  onDifferent,
  onClose,
}: {
  pairs: PairSuggestion[]
  peopleById: Map<string, Person>
  facesByPerson: Map<string, FaceRef[]>
  byId: Map<string, MediaItem>
  onSame(a: Person, b: Person): void
  onDifferent(a: Person, b: Person): void
  onClose(): void
}) {
  const [index, setIndex] = useState(0)
  const [answered, setAnswered] = useState(0)
  // Merges happen while reviewing: follow merged-away ids to whoever they became.
  const mergedInto = useRef(new Map<string, string>())
  const resolve = (id: string) => {
    let cur = id
    while (mergedInto.current.has(cur)) cur = mergedInto.current.get(cur)!
    return cur
  }

  let i = index
  let current: { a: Person; b: Person } | null = null
  while (i < pairs.length) {
    const a = peopleById.get(resolve(pairs[i].a))
    const b = peopleById.get(resolve(pairs[i].b))
    if (a && b && a.id !== b.id) {
      current = { a, b }
      break
    }
    i++
  }

  const next = () => setIndex(i + 1)
  const same = () => {
    if (!current) return
    const { a, b } = current
    // keep the named group, otherwise the bigger one
    const weight = (p: Person) => (p.name ? 1e9 : 0) + p.count
    const [into, from] = weight(a) >= weight(b) ? [a, b] : [b, a]
    mergedInto.current.set(from.id, into.id)
    onSame(from, into)
    setAnswered((n) => n + 1)
    next()
  }
  const different = () => {
    if (!current) return
    onDifferent(current.a, current.b)
    setAnswered((n) => n + 1)
    next()
  }

  useDialogKeys((e) => {
    const k = e.key.toLowerCase()
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (k === 'escape') onClose()
    else if (k === 'y') same()
    else if (k === 'n') different()
    else if (k === 's' || k === 'arrowright') next()
  })

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal review-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="merge-head">
          <h3>Same person?</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {current ? (
          <>
            <p>
              Suggestion {formatCount(i + 1)} of {formatCount(pairs.length)} · most likely matches first
            </p>
            <div className="review-pair">
              <PersonColumn person={current.a} faces={facesByPerson.get(current.a.id) ?? []} byId={byId} />
              <div className="review-vs">
                <ArrowRight size={18} />
              </div>
              <PersonColumn person={current.b} faces={facesByPerson.get(current.b.id) ?? []} byId={byId} />
            </div>
            <div className="review-actions">
              <button className="btn ghost" onClick={next} title="Skip (S)">
                Skip <kbd>S</kbd>
              </button>
              <div className="spacer" />
              <button className="btn" onClick={different} title="Different people (N)">
                Different people <kbd>N</kbd>
              </button>
              <button className="btn primary" onClick={same} title="Same person (Y)">
                <Check size={15} /> Same person <kbd>Y</kbd>
              </button>
            </div>
          </>
        ) : (
          <div className="review-done">
            <Check size={36} />
            <h3>All caught up</h3>
            <p>{answered ? `You reviewed ${formatCount(answered)} suggestions.` : 'No more suggestions right now.'}</p>
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
