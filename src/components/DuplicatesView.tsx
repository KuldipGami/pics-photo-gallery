import { Check, CopyCheck, Film, LoaderCircle, Maximize2, Trash } from 'lucide-react'
import { useMemo, useState } from 'react'
import { thumbUrl } from '../api'
import { baseName, formatBytes, formatCount, formatDuration, formatShortMonth } from '../lib/format'
import type { DuplicateGroup, DuplicatesData, DuplicatesProgress, MediaItem } from '../types'
import { EmptyState } from './Overlays'

const PAGE = 40
const groupKey = (g: DuplicateGroup) => g.ids.join(',')

interface Props {
  data: DuplicatesData
  progress: DuplicatesProgress
  byId: Map<string, MediaItem>
  /** Background analysis can't start until every preview exists. */
  waiting: boolean
  onDelete(ids: string[], label: string): void
  onDismiss(ids: string[]): void
  onOpen(ids: string[], index: number): void
}

export function DuplicatesView({ data, progress, byId, waiting, onDelete, onDismiss, onOpen }: Props) {
  const [tab, setTab] = useState<'exact' | 'similar'>('exact')
  const [keep, setKeep] = useState<Map<string, string>>(() => new Map())
  const [limit, setLimit] = useState(PAGE)

  // Groups whose items still exist (deleted ones disappear before the next scan finishes).
  const live = (groups: DuplicateGroup[]) =>
    groups
      .map((g) => ({ ...g, ids: g.ids.filter((id) => byId.has(id)) }))
      .filter((g) => g.ids.length > 1)
  const exact = useMemo(() => live(data.exact), [data.exact, byId])
  const similar = useMemo(() => live(data.similar), [data.similar, byId])
  const groups = tab === 'exact' ? exact : similar

  const keeperOf = (g: DuplicateGroup) => {
    const chosen = keep.get(groupKey(g))
    return chosen && g.ids.includes(chosen) ? chosen : g.ids.includes(g.keep) ? g.keep : g.ids[0]
  }
  const extras = (g: DuplicateGroup) => g.ids.filter((id) => id !== keeperOf(g))
  const bytesOf = (ids: string[]) => ids.reduce((s, id) => s + (byId.get(id)?.size ?? 0), 0)

  const exactExtras = exact.flatMap(extras)
  const exactBytes = bytesOf(exactExtras)

  const status =
    progress.running && progress.total
      ? `${progress.phase === 'hashing' ? 'Comparing file contents' : 'Comparing pictures'} · ${Math.floor((progress.done / progress.total) * 100)}%`
      : progress.running
        ? 'Checking your library…'
        : null

  if (!exact.length && !similar.length) {
    return status || waiting ? (
      <EmptyState
        icon={<LoaderCircle size={40} className="spin" />}
        title="Looking for duplicates…"
        text={waiting ? 'This starts as soon as every preview is ready.' : `${status}. You can keep using Lumen meanwhile.`}
      />
    ) : (
      <EmptyState icon={<CopyCheck size={44} strokeWidth={1.5} />} title="No duplicates" text="Every photo and video in your library is one of a kind." />
    )
  }

  return (
    <div className="dupes-scroll">
      <div className="dupes-summary">
        <div className="segmented small">
          <button className={tab === 'exact' ? 'active' : ''} onClick={() => setTab('exact')}>
            Exact copies <span className="chip-count">{formatCount(exact.length)}</span>
          </button>
          <button className={tab === 'similar' ? 'active' : ''} onClick={() => setTab('similar')}>
            Look-alikes <span className="chip-count">{formatCount(similar.length)}</span>
          </button>
        </div>
        <div className="dupes-summary-text">
          {tab === 'exact'
            ? `${formatCount(exactExtras.length)} extra ${exactExtras.length === 1 ? 'copy uses' : 'copies use'} ${formatBytes(exactBytes)}. Byte-for-byte identical — nothing is lost by removing them.`
            : 'The same picture resized, re-saved, edited or shot in a burst. The sharpest one is suggested — check before deleting.'}
          {status && <span className="dupes-status"> · {status}</span>}
        </div>
        {tab === 'exact' && exactExtras.length > 0 && (
          <button
            className="btn danger"
            onClick={() => onDelete(exactExtras, `${formatCount(exactExtras.length)} extra copies (${formatBytes(exactBytes)})`)}
          >
            <Trash size={15} /> Remove all extra copies
          </button>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="dupes-empty">{tab === 'exact' ? 'No exact copies.' : 'No look-alikes.'}</div>
      ) : (
        <div className="dupes-list">
          {groups.slice(0, limit).map((g) => {
            const keeper = keeperOf(g)
            const others = extras(g)
            const items = g.ids.map((id) => byId.get(id)!)
            return (
              <section key={groupKey(g)} className="dupe-group">
                <div className="dupe-head">
                  <div className="dupe-title">
                    {tab === 'exact'
                      ? `${formatCount(g.ids.length)} identical copies · ${formatBytes(items[0].size)} each`
                      : `${formatCount(g.ids.length)} look-alikes`}
                  </div>
                  <div className="spacer" />
                  <button className="btn ghost" onClick={() => onDismiss(g.ids)} title="Keep all of them and stop suggesting this group">
                    Not duplicates
                  </button>
                  <button
                    className="btn danger"
                    onClick={() =>
                      onDelete(others, others.length === 1 ? `“${byId.get(others[0])?.name}”` : `${formatCount(others.length)} items`)
                    }
                  >
                    <Trash size={15} /> Remove {others.length === 1 ? '1 other' : `${formatCount(others.length)} others`}
                  </button>
                </div>
                <div className="dupe-items">
                  {items.map((it, i) => {
                    const kept = it.id === keeper
                    const dims = data.dims[it.id]
                    return (
                      <div key={it.id} className={`dupe-card${kept ? ' kept' : ''}`}>
                        <button className="dupe-thumb" onClick={() => onOpen(g.ids, i)} title="Open">
                          <img src={thumbUrl(it)} alt="" loading="lazy" draggable={false} />
                          {it.type === 'video' && (
                            <span className="dupe-video">
                              <Film size={12} /> {formatDuration(it.duration)}
                            </span>
                          )}
                          <span className="dupe-open">
                            <Maximize2 size={14} />
                          </span>
                        </button>
                        <div className="dupe-info">
                          <div className="dupe-name" title={it.path}>
                            {it.name}
                          </div>
                          <div className="dupe-meta" title={it.dir}>
                            {baseName(it.dir)}
                          </div>
                          <div className="dupe-meta">
                            {[dims && `${dims[0]} × ${dims[1]}`, formatBytes(it.size), formatShortMonth(it.date)].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <button
                          className={`dupe-keep${kept ? ' on' : ''}`}
                          onClick={() => setKeep((prev) => new Map(prev).set(groupKey(g), it.id))}
                          aria-pressed={kept}
                        >
                          {kept ? (
                            <>
                              <Check size={14} strokeWidth={3} /> Keep
                            </>
                          ) : (
                            'Keep this instead'
                          )}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
          {groups.length > limit && (
            <button className="btn ghost dupes-more" onClick={() => setLimit((l) => l + PAGE)}>
              Show more ({formatCount(groups.length - limit)} left)
            </button>
          )}
        </div>
      )}
    </div>
  )
}
