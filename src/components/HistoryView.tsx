import { CalendarClock, Copy, FileImage, FolderInput, FolderOpen, History as HistoryIcon, Import, PenLine, RefreshCw, RotateCcw, Trash, Wand2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { baseName, formatBytes, formatCount } from '../lib/format'
import type { HistoryEntry } from '../types'
import { EmptyState } from './Overlays'

const timeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const plural = (n: number, one: string, many = one + 's') => `${formatCount(n)} ${n === 1 ? one : many}`

const ICON: Record<HistoryEntry['kind'], ReactNode> = {
  moved: <FolderInput size={18} />,
  recycled: <Trash size={18} />,
  copied: <Copy size={18} />,
  renamed: <PenLine size={18} />,
  dates: <CalendarClock size={18} />,
  edited: <Wand2 size={18} />,
  converted: <FileImage size={18} />,
  imported: <Import size={18} />,
}

export function historyTitle(e: HistoryEntry) {
  const n = e.files.length
  switch (e.kind) {
    case 'moved':
      return n ? `Moved ${plural(n, 'file')}` : `Gave ${plural(e.dateChanges?.length ?? 0, 'kept copy', 'kept copies')} the original date`
    case 'recycled':
      return `Sent ${plural(n, 'file')} to the Recycle Bin`
    case 'copied':
      return `Copied ${plural(n, 'file')} into folders`
    case 'renamed':
      return `Renamed ${plural(n, 'file')}`
    case 'dates':
      return `Fixed the date of ${plural(n, 'file')}`
    case 'edited':
      return `Edited ${plural(n, 'photo')}`
    case 'converted':
      return `Converted ${plural(n, 'HEIC photo')} to JPG`
    case 'imported':
      return `Imported ${plural(new Set(e.files.map((f) => f.from)).size, 'file')}${e.source?.name ? ` from ${e.source.name}` : ''}`
  }
}

const canRestore = (e: HistoryEntry) =>
  ['moved', 'renamed', 'dates', 'edited', 'converted', 'imported'].includes(e.kind) &&
  (e.files.some((f) => !f.restored) || (e.dateChanges ?? []).some((d) => !d.restored))

function detail(e: HistoryEntry) {
  switch (e.kind) {
    case 'recycled':
      return 'Restore them from the Recycle Bin if you need them back'
    case 'renamed':
      return 'Renamed in place'
    case 'dates':
      return 'File dates set from the dates in their names'
    case 'edited':
    case 'imported':
      return e.note ?? ''
    case 'converted':
      return e.destination ? `Originals moved to ${e.destination}` : 'JPG copies saved next to the originals'
    default:
      return e.destination ?? ''
  }
}

export function HistoryView({
  entries,
  onRestore,
  onClear,
}: {
  entries: HistoryEntry[]
  onRestore(e: HistoryEntry): void
  onClear(): void
}) {
  if (!entries.length) {
    return (
      <EmptyState
        icon={<HistoryIcon size={44} strokeWidth={1.5} />}
        title="Nothing here yet"
        text="Files you move, recycle, rename or fix from Clean up are listed here. Moved files can be put back where they came from."
      />
    )
  }
  return (
    <div className="folders-scroll">
      <div className="history-list">
        <div className="history-top">
          <span>Every change Lumen has made to your files. Moved files can be put back where they came from.</span>
          <button className="btn ghost" onClick={onClear}>
            Clear history
          </button>
        </div>
        {entries.map((e) => {
          const n = e.files.length
          const restored = e.files.filter((f) => f.restored).length
          const size = e.files.reduce((s, f) => s + (f.size ?? 0), 0)
          const status = e.kind === 'recycled' ? 'Recycle Bin' : restored === n && n ? 'Restored' : restored ? `${restored} of ${n} restored` : ''
          return (
            <section key={e.id} className={`history-card${e.kind === 'recycled' ? ' recycled' : ''}`}>
              <span className="history-icon">{ICON[e.kind]}</span>
              <div className="history-body">
                <div className="history-title">
                  <b>{historyTitle(e)}</b>
                  {size > 0 && !['renamed', 'dates', 'edited'].includes(e.kind) && <span className="history-size">{formatBytes(size)}</span>}
                  {status && <span className="pill">{status}</span>}
                </div>
                <div className="history-time">{timeFmt.format(e.time)}</div>
                {detail(e) && <div className="history-detail">{detail(e)}</div>}
                <div className="history-files">
                  {e.files
                    .slice(0, 4)
                    .map((f) => baseName(f.from))
                    .join(', ')}
                  {n > 4 ? ` and ${formatCount(n - 4)} more` : ''}
                </div>
              </div>
              <div className="history-actions">
                {e.destination && ['moved', 'copied', 'converted'].includes(e.kind) && (
                  <button className="btn ghost" onClick={() => api.revealFolder(e.destination!)}>
                    <FolderOpen size={15} /> Open folder
                  </button>
                )}
                {e.kind === 'recycled' && (
                  <button className="btn ghost" onClick={() => api.openRecycleBin()}>
                    <RefreshCw size={15} /> Open Recycle Bin
                  </button>
                )}
                {canRestore(e) && (
                  <button className="btn primary" onClick={() => onRestore(e)}>
                    <RotateCcw size={15} /> Restore
                  </button>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
