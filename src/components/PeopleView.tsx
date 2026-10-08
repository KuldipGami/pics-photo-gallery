import { Check, Eye, LoaderCircle, ScanFace, Sparkles, TriangleAlert } from 'lucide-react'
import { formatCount } from '../lib/format'
import type { MediaItem, PeopleProgress, Person } from '../types'
import { FaceAvatar } from './FaceAvatar'
import { EmptyState } from './Overlays'

export type PeopleSort = 'count' | 'name'

interface Props {
  people: Person[]
  byId: Map<string, MediaItem>
  enabled: boolean
  progress: PeopleProgress
  hiddenCount: number
  showHidden: boolean
  smallCount: number
  showSmall: boolean
  suggestionCount: number
  selection: Set<string>
  onToggleHidden(): void
  onToggleSmall(): void
  onToggleSelect(id: string): void
  onOpen(id: string): void
  onEnable(): void
  onReview(): void
}

export function PeopleView(props: Props) {
  const { people, byId, enabled, progress, selection } = props
  const selecting = selection.size > 0

  if (!enabled) {
    return (
      <EmptyState
        icon={<ScanFace size={44} strokeWidth={1.5} />}
        title="Face recognition is off"
        text="Turn it on to group your photos by the people in them. Everything is analysed on this computer — nothing is uploaded."
        action={
          <button className="btn primary large" onClick={props.onEnable}>
            <ScanFace size={17} /> Turn on face recognition
          </button>
        }
      />
    )
  }

  if (!people.length && !props.smallCount && !props.hiddenCount) {
    return progress.running ? (
      <EmptyState
        icon={<LoaderCircle size={40} className="spin" />}
        title="Finding people…"
        text={`Looking for faces in your photos (${formatCount(progress.done)} of ${formatCount(progress.total)}). People appear here once someone shows up in a few photos.`}
      />
    ) : (
      <EmptyState
        icon={<ScanFace size={44} strokeWidth={1.5} />}
        title={progress.error ? "Face recognition isn't running" : 'No people yet'}
        text={
          progress.error ??
          'People show up here once the same face appears in at least three photos. New photos are analysed automatically.'
        }
      />
    )
  }

  return (
    <div className="people-scroll">
      {/* face analysis stopped (couldn't start, its data couldn't be read, keeps failing): the people found so far stay */}
      {progress.error && (
        <div className="review-banner warn" role="status">
          <TriangleAlert size={18} />
          <div>
            <strong>Face recognition isn't running.</strong>
            <span> {progress.error}</span>
          </div>
        </div>
      )}
      {progress.upgrading && progress.running && (
        <div className="review-banner">
          <LoaderCircle size={18} className="spin" />
          <div>
            <strong>Upgrading to a more accurate face model · {progress.total ? Math.floor((progress.done / progress.total) * 100) : 0}%</strong>
            <span> Your names and corrections are kept. Groups will tidy themselves up as photos are re-checked.</span>
          </div>
        </div>
      )}
      {props.suggestionCount > 0 && !(progress.upgrading && progress.running) && (
        <div className="review-banner">
          <Sparkles size={18} />
          <div>
            <strong>
              {props.suggestionCount >= 300 ? '300+' : formatCount(props.suggestionCount)} pairs of groups might be the
              same person.
            </strong>
            <span> Quickly confirm or reject each match — it's the fastest way to tidy up People.</span>
          </div>
          <button className="btn primary" onClick={props.onReview}>
            Review
          </button>
        </div>
      )}
      <div className="people-grid">
        {people.map((p) => {
          const selected = selection.has(p.id)
          return (
            <div
              key={p.id}
              className={`person-card${p.hidden ? ' is-hidden' : ''}${selected ? ' selected' : ''}${selecting ? ' selecting' : ''}`}
              onClick={(e) => (selecting || e.ctrlKey ? props.onToggleSelect(p.id) : props.onOpen(p.id))}
              role="button"
              tabIndex={0}
            >
              <span className="person-avatar">
                <FaceAvatar item={byId.get(p.cover.item)} box={p.cover.box} ar={p.cover.ar} size={132} />
                <button
                  className="thumb-check"
                  aria-label={selected ? 'Deselect' : 'Select'}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onToggleSelect(p.id)
                  }}
                >
                  <Check size={13} strokeWidth={3} />
                </button>
              </span>
              <div className={`person-name${p.name ? '' : ' unnamed'}`}>{p.name || 'Add a name'}</div>
              <div className="person-meta">
                {formatCount(p.count)} photo{p.count === 1 ? '' : 's'}
              </div>
            </div>
          )
        })}
      </div>
      {(props.smallCount > 0 || props.hiddenCount > 0) && (
        <div className="people-footer">
          {props.smallCount > 0 && (
            <button className="btn ghost" onClick={props.onToggleSmall}>
              {props.showSmall ? 'Hide small groups' : `Show ${formatCount(props.smallCount)} small groups (1–2 photos)`}
            </button>
          )}
          {props.hiddenCount > 0 && (
            <button className="btn ghost" onClick={props.onToggleHidden}>
              <Eye size={15} />
              {props.showHidden ? 'Hide hidden people' : `Show ${formatCount(props.hiddenCount)} hidden`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
