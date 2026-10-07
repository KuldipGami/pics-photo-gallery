import { Clock, Folder, Heart, Images, LoaderCircle, RefreshCw, Settings, Film, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { formatCount } from '../lib/format'
import type { PeopleProgress, ScanStatus, ThumbProgress, View } from '../types'

interface Props {
  view: View
  onNavigate(view: View): void
  counts: { all: number; videos: number; favorites: number; folders: number; people: number }
  status: ScanStatus
  thumbProgress: ThumbProgress
  peopleProgress: PeopleProgress
}

export function Sidebar({ view, onNavigate, counts, status, thumbProgress, peopleProgress }: Props) {
  const { pending, total } = thumbProgress
  const preparedPct = total ? Math.floor(((total - pending) / total) * 100) : 100
  const peoplePct = peopleProgress.total ? Math.floor((peopleProgress.done / peopleProgress.total) * 100) : 0
  const active = (kind: View['kind']) =>
    view.kind === kind || (kind === 'folders' && view.kind === 'folder') || (kind === 'people' && view.kind === 'person')

  const item = (kind: View['kind'], label: string, icon: ReactNode, count?: number) => (
    <button
      className={`nav-item${active(kind) ? ' active' : ''}`}
      onClick={() => onNavigate({ kind } as View)}
      aria-current={active(kind) ? 'page' : undefined}
    >
      {icon}
      <span className="nav-label">{label}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{formatCount(count)}</span>}
    </button>
  )

  return (
    <nav className="sidebar">
      <div className="nav-section">
        {item('photos', 'Photos', <Images size={18} />, counts.all)}
        {item('videos', 'Videos', <Film size={18} />, counts.videos)}
        {item('favorites', 'Favorites', <Heart size={18} />, counts.favorites)}
        {item('people', 'People', <Users size={18} />, counts.people)}
        {item('recent', 'Recently added', <Clock size={18} />)}
      </div>
      <div className="nav-heading">Library</div>
      <div className="nav-section">
        {item('folders', 'Folders', <Folder size={18} />, counts.folders)}
      </div>

      <div className="sidebar-spacer" />

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
            <span title={`${formatCount(thumbProgress.pending)} previews left`}>
              Preparing previews · {preparedPct}%
            </span>
            <span className="scan-progress" style={{ width: `${preparedPct}%` }} />
          </>
        ) : peopleProgress.running ? (
          <>
            <LoaderCircle size={14} className="spin" />
            <span title={`${formatCount(peopleProgress.done)} of ${formatCount(peopleProgress.total)} photos analysed`}>
              {peopleProgress.upgrading ? 'Upgrading face recognition' : 'Finding people'} · {peoplePct}%
            </span>
            <span className="scan-progress" style={{ width: `${peoplePct}%` }} />
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
