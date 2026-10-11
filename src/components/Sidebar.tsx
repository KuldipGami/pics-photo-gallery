import { Album as AlbumIcon, Clock, CopyX, Folder, Heart, History, Images, Import, LoaderCircle, LockKeyhole, Map as MapIcon, MapPin, Plus, RefreshCw, Settings, Film, FolderTree, Sparkles, Users } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { api } from '../api'
import { formatBytes, formatCount } from '../lib/format'
import type { Album, DuplicatesProgress, MediaItem, PeopleProgress, ScanStatus, SmartProgress, ThumbProgress, VideosProgress, OcrProgress, View } from '../types'
import { albumCover } from './AlbumsView'
import { CoverImage } from './CoverImage'

interface Props {
  view: View
  onNavigate(view: View): void
  /** `photos`: what the Photos tab shows now (photos, Live Photos, or everything). */
  counts: { all: number; photos: number; videos: number; favorites: number; folders: number; people: number; places: number; trips: number }
  albums: Album[]
  byId: Map<string, MediaItem>
  duplicateBytes: number
  status: ScanStatus
  thumbProgress: ThumbProgress
  peopleProgress: PeopleProgress
  smartProgress: SmartProgress
  dupesProgress: DuplicatesProgress
  videosProgress?: VideosProgress
  ocrProgress?: OcrProgress
  /** "Watching 2 folders for new duplicates" (empty when not watching). */
  watchStatus?: string
  onNewAlbum(): void
  /** True while photos from the grid are being dragged (they can be dropped on an album). */
  canDropItems(): boolean
  onDropOnAlbum(albumId: string): void
}

const pct = (done: number, total: number) => (total ? Math.min(100, Math.floor((done / total) * 100)) : 0)

/**
 * A background task's line: "Label · 45%". Hovering it shows a card above with the whole label and
 * "1,234 of 14,800 photos · 45%" (the line itself is too narrow for both).
 */
function Running({ label, done, total, noun }: { label: string; done: number; total: number; noun: string }) {
  const p = pct(done, total)
  return (
    <>
      <LoaderCircle size={14} className="spin" />
      <span>
        {label} · {p}%
      </span>
      <span className="scan-tip" role="tooltip">
        <strong>{label}</strong>
        <span>
          {formatCount(Math.min(done, total))} of {formatCount(total)} {noun} · {p}%
        </span>
      </span>
      <span className="scan-progress" style={{ width: `${p}%` }} />
    </>
  )
}

export function Sidebar(props: Props) {
  const { view, onNavigate, counts, status, thumbProgress, peopleProgress, smartProgress, dupesProgress } = props
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const { pending, total } = thumbProgress
  const away = status.unreachable ?? [] // library folders not connected (their items are kept)
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
          {item('photos', 'Photos', <Images size={18} />, counts.photos)}
          {item('videos', 'Videos', <Film size={18} />, counts.videos)}
          {item('favorites', 'Favorites', <Heart size={18} />, counts.favorites)}
          {item('memories', 'Memories', <Sparkles size={18} />, counts.trips)}
          {item('people', 'People', <Users size={18} />, counts.people)}
          {item('places', 'Places', <MapPin size={18} />, counts.places)}
          {item('map', 'Map', <MapIcon size={18} />)}
          {item('recent', 'Recently added', <Clock size={18} />)}
        </div>
        <div className="nav-heading">Library</div>
        <div className="nav-section">
          {item('import', 'Import', <Import size={18} />)}
          {item('folders', 'Folders', <Folder size={18} />, counts.folders)}
          {item('cleanup', 'Clean up', <CopyX size={18} />, props.duplicateBytes > 0 ? formatBytes(props.duplicateBytes) : undefined)}
          {item('organize', 'Organize', <FolderTree size={18} />)}
          {item('private', 'Private', <LockKeyhole size={18} />)}
          {item('history', 'History', <History size={18} />)}
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
                  if (a.query || !props.canDropItems()) return
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
                  <CoverImage item={cover} fallback={a.query ? <Sparkles size={14} /> : <AlbumIcon size={14} />} />
                </span>
                <span className="nav-label">{a.name}</span>
                {a.query ? (
                  <Sparkles size={13} className="nav-smart" aria-label="Smart album" />
                ) : (
                  <span className="nav-count">{formatCount(a.items.length)}</span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="nav-section">{item('settings', 'Settings', <Settings size={18} />)}</div>
      {props.watchStatus && (
        <div className="nav-watch" title="Pics tells you when a new photo or video is a copy of one you already have">
          <span className="dot on" />
          <span>{props.watchStatus}</span>
        </div>
      )}

      <div className="scan-status">
        {status.scanning ? (
          <>
            <LoaderCircle size={14} className="spin" />
            <span>Scanning… {status.found ? `${formatCount(status.found)} found` : ''}</span>
          </>
        ) : thumbProgress.pending > 0 ? (
          <Running label="Preparing previews" done={total - pending} total={total} noun="previews" />
        ) : peopleProgress.running ? (
          <Running label={peopleProgress.upgrading ? 'Upgrading face recognition' : 'Finding people'} done={peopleProgress.done} total={peopleProgress.total} noun="photos" />
        ) : smartProgress.running ? (
          <Running label="Preparing smart search" done={smartProgress.done} total={smartProgress.total} noun="photos and videos" />
        ) : dupesProgress.running ? (
          <Running label="Finding duplicates" done={dupesProgress.done} total={dupesProgress.total} noun={dupesProgress.phase === 'comparing' ? 'compared' : 'photos and videos'} />
        ) : props.ocrProgress?.running ? (
          <Running label="Reading text in photos" done={props.ocrProgress.done} total={props.ocrProgress.total} noun="photos" />
        ) : props.videosProgress?.running ? (
          <Running label="Comparing videos" done={props.videosProgress.done} total={props.videosProgress.total} noun="videos" />
        ) : (
          <>
            <span className={`scan-dot${away.length ? ' away' : ''}`} />
            <span>{away.length ? `Up to date · ${away.length === 1 ? 'a folder' : `${away.length} folders`} not connected` : 'Library up to date'}</span>
            {away.length > 0 && (
              <span className="scan-tip" role="tooltip">
                <strong>Not connected</strong>
                {away.map((f) => (
                  <span key={f} className="scan-tip-path">
                    {f}
                  </span>
                ))}
                <span>Pics keeps what it found in {away.length === 1 ? 'it' : 'them'} (previews, people, text, duplicates) and carries on when the drive is back, even under another letter.</span>
              </span>
            )}
            <button className="icon-btn tiny" title="Rescan library (F5)" onClick={() => api.rescan()}>
              <RefreshCw size={13} />
            </button>
          </>
        )}
      </div>
    </nav>
  )
}
