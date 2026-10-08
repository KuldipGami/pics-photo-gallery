import { Luggage, Sparkles, X } from 'lucide-react'
import { formatCount, formatLongDate } from '../lib/format'
import { formatTripDates } from '../lib/memories'
import type { MediaItem, Memory, Trip } from '../types'
import { CoverImage } from './CoverImage'
import { EmptyState } from './Overlays'

/** The "On this day" cards: one per earlier year. Opens straight into the viewer. */
export function MemoryCards({ memories, byId, onOpen }: { memories: Memory[]; byId: Map<string, MediaItem>; onOpen(m: Memory): void }) {
  return (
    <div className="memory-row">
      {memories.map((m) => (
        <button key={m.label} className="memory-card" onClick={() => onOpen(m)} title={formatLongDate(m.date)}>
          <CoverImage item={byId.get(m.cover)} fallback={<Sparkles size={28} />} />
          <span className="memory-shade" />
          <span className="memory-text">
            <b>{m.label}</b>
            <span>
              {new Date(m.date).getFullYear()} · {formatCount(m.items.length)} {m.items.length === 1 ? 'item' : 'items'}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

/** A slim "On this day" strip above Photos. */
export function MemoryStrip({
  memories,
  byId,
  onOpen,
  onDismiss,
}: {
  memories: Memory[]
  byId: Map<string, MediaItem>
  onOpen(m: Memory): void
  onDismiss(): void
}) {
  return (
    <div className="memory-strip">
      <div className="memory-strip-head">
        <Sparkles size={15} />
        <span>On this day</span>
        <button className="icon-btn tiny" onClick={onDismiss} title="Hide for today">
          <X size={13} />
        </button>
      </div>
      <MemoryCards memories={memories} byId={byId} onOpen={onOpen} />
    </div>
  )
}

export function MemoriesView({
  memories,
  trips,
  byId,
  hasPlaces,
  onOpenMemory,
  onOpenTrip,
}: {
  memories: Memory[]
  trips: Trip[]
  byId: Map<string, MediaItem>
  hasPlaces: boolean
  onOpenMemory(m: Memory): void
  onOpenTrip(id: string): void
}) {
  if (!memories.length && !trips.length) {
    return (
      <EmptyState
        icon={<Sparkles size={44} strokeWidth={1.5} />}
        title="No memories yet"
        text={
          hasPlaces
            ? 'Trips show up here once you have photos taken away from home, and “On this day” brings back photos from this date in earlier years.'
            : 'Trips need photos that recorded where they were taken. “On this day” brings back photos from this date in earlier years.'
        }
      />
    )
  }
  return (
    <div className="folders-scroll">
      {memories.length > 0 && (
        <section className="memories-section">
          <h2>On this day</h2>
          <MemoryCards memories={memories} byId={byId} onOpen={onOpenMemory} />
        </section>
      )}
      {trips.length > 0 && (
        <section className="memories-section">
          <h2>Trips</h2>
          <div className="folders-grid trips-grid">
            {trips.map((t) => (
              <button key={t.id} className="folder-card trip-card" onClick={() => onOpenTrip(t.id)} title={`${t.title} · ${t.where}`}>
                <div className="folder-cover n1">
                  <CoverImage item={byId.get(t.cover)} fallback={<Luggage size={32} />} lazy />
                </div>
                <div className="folder-name">{t.title}</div>
                <div className="folder-meta">
                  {formatTripDates(t.start, t.end)} · {formatCount(t.items.length)} items
                </div>
                {t.where && <div className="folder-meta trip-where">{t.where}</div>}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
