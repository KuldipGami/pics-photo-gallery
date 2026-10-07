import { MapPin } from 'lucide-react'
import { useMemo } from 'react'
import { formatCount } from '../lib/format'
import type { MediaItem, Place } from '../types'
import { CoverImage } from './CoverImage'

export interface Country {
  cc: string
  name: string
  count: number
}

export function countriesOf(places: Place[]): Country[] {
  const map = new Map<string, Country>()
  for (const p of places) {
    let c = map.get(p.cc)
    if (!c) map.set(p.cc, (c = { cc: p.cc, name: p.country, count: 0 }))
    c.count += p.count
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

export function PlacesView({
  places,
  byId,
  country,
  onCountry,
  onOpen,
}: {
  places: Place[]
  byId: Map<string, MediaItem>
  /** Country filter (ISO code), or null for all. */
  country: string | null
  onCountry(cc: string | null): void
  onOpen(id: string): void
}) {
  const countries = useMemo(() => countriesOf(places), [places])
  const shown = country ? places.filter((p) => p.cc === country) : places
  return (
    <div className="folders-scroll">
      {countries.length > 1 && (
        <div className="chip-row">
          <button className={`chip${country === null ? ' active' : ''}`} onClick={() => onCountry(null)}>
            All countries
          </button>
          {countries.map((c) => (
            <button key={c.cc} className={`chip${country === c.cc ? ' active' : ''}`} onClick={() => onCountry(c.cc)}>
              {c.name} <span className="chip-count">{formatCount(c.count)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="folders-grid places-grid">
        {shown.map((p) => {
          return (
            <button key={p.id} className="folder-card place-card" onClick={() => onOpen(p.id)} title={`${p.name}, ${p.admin}, ${p.country}`}>
              <div className="folder-cover n1">
                <CoverImage item={byId.get(p.cover)} fallback={<MapPin size={32} />} lazy />
                <span className="place-badge">{formatCount(p.count)}</span>
              </div>
              <div className="folder-name">{p.name}</div>
              <div className="folder-meta">{[p.admin, p.country].filter(Boolean).join(', ')}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
