import { Album as AlbumIcon, Clock, CopyX, Folder, Heart, Images, LoaderCircle, MapPin, Plus, RefreshCw, Settings, Film, Sparkles, Users } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { api } from '../api'
import { formatBytes, formatCount } from '../lib/format'
import type { Album, DuplicatesProgress, MediaItem, PeopleProgress, ScanStatus, SmartProgress, ThumbProgress, View } from '../types'
import { albumCover } from './AlbumsView'
import { CoverImage } from './CoverImage'

interface Props {
  view: View
  onNavigate(view: View): void
  counts: { all: number; videos: number; favorites: number; folders: number; people: number; places: number; trips: number }
  albums: Album[]
  byId: Map<string, MediaItem>
  duplicateBytes: number
  status: ScanStatus
  thumbProgress: ThumbProgress
  peopleProgress: PeopleProgress
  smartProgress: SmartProgress
  dupesProgress: DuplicatesProgress
  onNewAlbum(): void
  /** True while photos from the grid are being dragged (they can be dropped on an album). */
  canDropItems(): boolean
  onDropOnAlbum(albumId: string): void
}

const pct = (done: number, total: number) => (total ? Math.floor((done / total) * 100) : 0)

export function Sidebar(props: Props) {
  const { view, onNavigate, counts, status, thumbProgress, peopleProgress, smartProgress, dupesProgress } = props
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const { pending, total } = thumbProgress
  const preparedPct = total ? Math.floor(((total - pending) / total) * 100) : 100
  const active = (kind: View['kind']) =>
    view.kind === kind ||
    (kind === 'folders' && view.kind === 'folder') ||
    (kind === 'people' && view.kind === 'person') ||
    (kind === 'places' && view.kind === 'place') ||
    (kind === 'memories' && view.kind === 'trip')

  const item = (kind: View['kind'], label: string, icon: ReactNode, count?: number | string) => (
    <button
      className={`nav-item${active(kind) ? ' active' : ''}`}
      onClick={() => onNavigate({ kind } as View)}
      aria-current={active(kind) ? 'page' : undefined}
    >
      {icon}
      <span className="nav-label">{label}</span>
      {count !== undefined && count !== 0 && <span className="nav-count">{typeof count === 'number' ? formatCount(count) : count}</span>}
    </button>
  )

  return (
    <nav className="sidebar">
      <div className="sidebar-scroll">
        <div className="nav-section">
          {item('photos', 'Photos', <Images size={18} />, counts.all)}
          {item('videos', 'Videos', <Film size={18} />, counts.videos)}
          {item('favorites', 'Favorites', <Heart size={18} />, counts.favorites)}
          {item('memories', 'Memories', <Sparkles size={18} />, counts.trips)}
          {item('people', 'People', <Users size={18} />, counts.people)}
          {item('places', 'Places', <MapPin size={18} />, counts.places)}
          {item('recent', 'Recently added', <Clock size={18} />)}
        </div>
        <div className="nav-heading">Library</div>
        <div className="nav-section">
          {item('folders', 'Folders', <Folder size={18} />, counts.folders)}
          {item('duplicates', 'Duplicates', <CopyX size={18} />, props.duplicateBytes > 0 ? formatBytes(props.duplicateBytes) : undefined)}
        </div>
        <div className="nav-heading with-action">
          <span>Albums</span>
          <button className="icon-btn tiny" title="New album" onClick={props.onNewAlbum}>
            <Plus size={14} />
          </button>
        </div>
        <div className="nav-section">
          {item('albums', 'All albums', <AlbumIcon size={18} />, props.albums.length)}
          {props.albums.map((a) => {
            const on = view.kind === 'album' && view.id === a.id
            const cover = albumCover(a, props.byId)
            return (
              <button
                key={a.id}
                className={`nav-item album-item${on ? ' active' : ''}${dropTarget === a.id ? ' drop' : ''}`}
                onClick={() => onNavigate({ kind: 'album', id: a.id })}
                aria-current={on ? 'page' : undefined}
                title={a.name}
                onDragOver={(e) => {
                  if (!props.canDropItems()) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  setDropTarget(a.id)
                }}
                onDragLeave={() => setDropTarget((t) => (t === a.id ? null : t))}
                onDrop={(e) => {
                  setDropTarget(null)
                  if (!props.canDropItems()) return
                  e.preventDefault()
                  e.stopPropagation()
                  props.onDropOnAlbum(a.id)
                }}
              >
                <span className="nav-album-thumb">
                  <CoverImage item={cover} fallback={<AlbumIcon size={14} />} />
                </span>
                <span className="nav-label">{a.name}</span>
                <span className="nav-count">{formatCount(a.items.length)}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="nav-section">{item('settings', 'Settings', <Settings size={18} />)}</div>

      <div className="scan-status">
        {status.scanning ? (
          <>
            <LoaderCircle size={14} className="spin" />
            <span>Scanning… {status.found ? `${formatCount(status.found)} found` : ''}</span>
          </>
        ) : thumbProgress.pending > 0 ? (
          <>
            <LoaderCircle size={14} className="spin" />
            <span title={`${formatCount(thumbProgress.pending)} previews left`}>Preparing previews · {preparedPct}%</span>
            <span className="scan-progress" style={{ width: `${preparedPct}%` }} />
          </>
        ) : peopleProgress.running ? (
          <>
            <LoaderCircle size={14} className="spin" />
            <span title={`${formatCount(peopleProgress.done)} of ${formatCount(peopleProgress.total)} photos analysed`}>
              {peopleProgress.upgrading ? 'Upgrading face recognition' : 'Finding people'} · {pct(peopleProgress.done, peopleProgress.total)}%
            </span>
            <span className="scan-progress" style={{ width: `${pct(peopleProgress.done, peopleProgress.total)}%` }} />
          </>
        ) : smartProgress.running ? (
          <>
            <LoaderCircle size={14} className="spin" />
            <span title={`${formatCount(smartProgress.done)} of ${formatCount(smartProgress.total)} items`}>
              Preparing smart search · {pct(smartProgress.done, smartProgress.total)}%
            </span>
            <span className="scan-progress" style={{ width: `${pct(smartProgress.done, smartProgress.total)}%` }} />
          </>
        ) : dupesProgress.running ? (
          <>
            <LoaderCircle size={14} className="spin" />
            <span>Finding duplicates · {pct(dupesProgress.done, dupesProgress.total)}%</span>
            <span className="scan-progress" style={{ width: `${pct(dupesProgress.done, dupesProgress.total)}%` }} />
          </>
        ) : (
          <>
            <span className="scan-dot" />
            <span>Library up to date</span>
            <button className="icon-btn tiny" title="Rescan library (F5)" onClick={() => api.rescan()}>
              <RefreshCw size={13} />
            </button>
          </>
        )}
      </div>
    </nav>
  )
}
