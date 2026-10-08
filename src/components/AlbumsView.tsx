import { Album as AlbumIcon, Check, Pencil, Plus, Search, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatCount, formatRange } from '../lib/format'
import { fold } from '../lib/search'
import type { Album, MediaItem } from '../types'
import { CoverImage } from './CoverImage'
import { useDialogKeys } from './PersonDialogs'

/** The album's chosen cover, else its newest photo (else newest video). */
export function albumCover(album: Album, byId: Map<string, MediaItem>) {
  const chosen = album.cover ? byId.get(album.cover) : undefined
  if (chosen) return chosen
  let best: MediaItem | undefined
  const rank = (it: MediaItem) => (it.type === 'image' ? 1 : 0)
  for (const id of album.items) {
    const it = byId.get(id)
    if (it && (!best || rank(it) > rank(best) || (rank(it) === rank(best) && it.date > best.date))) best = it
  }
  return best
}

export const albumItems = (album: Album, byId: Map<string, MediaItem>) =>
  album.items.map((id) => byId.get(id)).filter((it): it is MediaItem => !!it)

export function AlbumsView({
  albums,
  byId,
  onOpen,
  onCreate,
}: {
  albums: Album[]
  byId: Map<string, MediaItem>
  onOpen(id: string): void
  onCreate(): void
}) {
  return (
    <div className="folders-scroll">
      <div className="folders-grid albums-grid">
        <button className="folder-card album-new" onClick={onCreate}>
          <div className="folder-cover album-cover-new">
            <Plus size={30} />
          </div>
          <div className="folder-name">New album</div>
          <div className="folder-meta">Collect photos from anywhere</div>
        </button>
        {albums.map((a) => {
          const items = albumItems(a, byId)
          const cover = albumCover(a, byId)
          const range = formatRange(items)
          return (
            <button key={a.id} className="folder-card" onClick={() => onOpen(a.id)} title={a.name}>
              <div className="folder-cover n1">
                <CoverImage item={cover} fallback={a.query ? <Sparkles size={32} /> : <AlbumIcon size={32} />} />
              </div>
              <div className="folder-name">{a.name}</div>
              <div className="folder-meta">
                {a.query ? (
                  <>Smart album · “{a.query}”</>
                ) : (
                  <>
                    {formatCount(items.length)} item{items.length === 1 ? '' : 's'}
                    {range ? ` · ${range}` : ''}
                  </>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The album's name in the header; click to rename. */
export function AlbumTitle({ album, onRename }: { album: Album; onRename(name: string): void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(album.name)
  useEffect(() => {
    if (!editing) setValue(album.name)
  }, [album.name, editing])

  if (!editing) {
    return (
      <button className="person-title" onClick={() => setEditing(true)} title="Rename">
        <h1>{album.name}</h1>
        <Pencil size={15} />
      </button>
    )
  }
  const commit = () => {
    setEditing(false)
    if (value.trim() && value.trim() !== album.name) onRename(value.trim())
  }
  return (
    <div className="person-title-edit">
      <input
        autoFocus
        value={value}
        placeholder="Album name"
        maxLength={80}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setValue(album.name)
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

/** "Add to album…": pick an album, or type a name to start a new one. */
export function AlbumPicker({
  albums,
  byId,
  count,
  onPick,
  onCreate,
  onClose,
}: {
  albums: Album[]
  byId: Map<string, MediaItem>
  /** How many items are being added (for the description). */
  count: number
  onPick(album: Album): void
  onCreate(name: string): void
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const q = fold(query.trim())
  const list = useMemo(
    () => [...albums].filter((a) => !a.query && (!q || fold(a.name).includes(q))).sort((a, b) => b.updated - a.updated),
    [albums, q],
  )
  const exact = list.some((a) => fold(a.name) === q)

  useEffect(() => inputRef.current?.focus(), [])
  useDialogKeys((e) => {
    if (e.key === 'Escape') onClose()
  })

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal picker-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="merge-head">
          <h3>Add to album</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <p>
          {count === 1 ? 'This item' : `${formatCount(count)} items`} will be added. Your files stay where they are.
        </p>
        <div className="merge-search">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search albums, or type a new album name"
            maxLength={80}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              if (list.length === 1 && q) onPick(list[0])
              else if (query.trim() && !exact) onCreate(query.trim())
            }}
          />
        </div>
        <div className="merge-list">
          <button className="merge-row new-person" onClick={() => onCreate(query.trim())}>
            <span className="new-person-icon">
              <Plus size={18} />
            </span>
            <span>{query.trim() && !exact ? `New album “${query.trim()}”` : 'New album'}</span>
          </button>
          {list.map((a) => {
            const cover = albumCover(a, byId)
            return (
              <button key={a.id} className="merge-row" onClick={() => onPick(a)}>
                <span className="album-thumb">
                  <CoverImage item={cover} fallback={<AlbumIcon size={18} />} />
                </span>
                <span>{a.name}</span>
                <span className="merge-count">{formatCount(a.items.length)}</span>
              </button>
            )
          })}
          {!list.length && albums.length > 0 && <div className="merge-empty">No albums match.</div>}
        </div>
      </div>
    </div>
  )
}

/** Name a new album. */
export function AlbumNameDialog({
  title,
  initial = '',
  confirmLabel,
  onSubmit,
  onClose,
}: {
  title: string
  initial?: string
  confirmLabel: string
  onSubmit(name: string): void
  onClose(): void
}) {
  const [value, setValue] = useState(initial)
  useDialogKeys((e) => {
    if (e.key === 'Escape') onClose()
  })
  const submit = () => {
    if (value.trim()) onSubmit(value.trim())
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="merge-search name-field">
          <AlbumIcon size={15} />
          <input
            autoFocus
            value={value}
            placeholder="Album name, e.g. Goa trip 2024"
            maxLength={80}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
