import { Folder } from 'lucide-react'
import { thumbUrl } from '../api'
import { formatCount, formatShortMonth } from '../lib/format'
import type { MediaItem } from '../types'

export interface FolderInfo {
  dir: string
  name: string
  count: number
  latest: number
  covers: MediaItem[]
}

export function FoldersView({ folders, onOpen }: { folders: FolderInfo[]; onOpen(dir: string): void }) {
  return (
    <div className="folders-scroll">
      <div className="folders-grid">
        {folders.map((f) => (
          <button key={f.dir} className="folder-card" onClick={() => onOpen(f.dir)} title={f.dir}>
            <div className={`folder-cover n${Math.min(3, f.covers.length)}`}>
              {f.covers.length ? (
                f.covers.map((c) => <img key={c.id} src={thumbUrl(c)} alt="" draggable={false} />)
              ) : (
                <Folder size={32} />
              )}
            </div>
            <div className="folder-name">{f.name}</div>
            <div className="folder-meta">
              {formatCount(f.count)} item{f.count === 1 ? '' : 's'} · {formatShortMonth(f.latest)}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
