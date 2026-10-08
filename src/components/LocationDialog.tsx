import L from 'leaflet'
import { Crosshair, LoaderCircle, MapPin, Search, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { thumbUrl } from '../api'
import { formatCount, formatLongDate, formatRange, formatTime, summarize } from '../lib/format'
import type { MediaItem } from '../types'
import { createBaseMap, hasPosition } from './MapView'
import { useDialogKeys } from './PersonDialogs'
import './location-dialog.css'

/**
 * "Add location" for one or more photos/videos: suggestions from photos taken around the same
 * time (electron/location-suggest.cjs), a town search (offline GeoNames), and a small map to click
 * or drag the pin. Props-driven: every lookup and the save go through callbacks.
 */

/** A town from the offline list (or typed coordinates). */
export interface PlaceHit {
  name: string
  admin: string
  country: string
  cc: string
  lat: number
  lon: number
  pop: number
  /** The query was a pair of coordinates. */
  coordinates?: boolean
}

/** The town a position belongs to; `km` from its centre. */
export interface PlaceName {
  name: string
  admin: string
  country: string
  cc: string
  km: number
}

export type Confidence = 'high' | 'medium' | 'low'

export interface LocationSuggestion {
  id: string
  lat: number
  lon: number
  name: string
  admin: string
  country: string
  cc: string
  /** Selected items whose closest photo in time was taken here. */
  targets: string[]
  /** Photos (with a position) that suggest it, closest first. */
  sources: string[]
  /** Time to the closest of them (ms). */
  gap: number
  confidence: Confidence
  /** Nobody's closest match, but photographed around that time. */
  alternative?: boolean
}

export interface LocationSuggestions {
  /** Time window used (ms). */
  window: number
  perItem: Record<string, { lat: number; lon: number; from: string; gap: number; confidence: Confidence }>
  suggestions: LocationSuggestion[]
  /** Items with nothing taken within the window. */
  missing: string[]
}

export interface LocationAssignment {
  id: string
  lat: number
  lon: number
}

export interface LocationDialogProps {
  /** The items to give a location. */
  items: MediaItem[]
  /** The library, to show the photos suggestions come from. */
  byId: Map<string, MediaItem>
  /** Suggestions from photos taken within `hours` of the items. */
  suggest(hours: number): Promise<LocationSuggestions>
  search(query: string): Promise<PlaceHit[]>
  describe(lat: number, lon: number): Promise<PlaceName | null>
  /** `label`: where, in words (for History and a toast). */
  onSave(assignments: LocationAssignment[], label: string): void
  onCancel(): void
  thumb?: (item: MediaItem) => string
  onOpenUrl?(url: string): void
}

type Choice =
  | { kind: 'point'; lat: number; lon: number; title: string; sub: string; key: string; zoom?: number }
  | { kind: 'matched' }

const WINDOWS = [1, 3, 6, 12, 24]
const HOUR = 3_600_000
const JPEG = new Set(['jpg', 'jpeg', 'jpe', 'jfif'])

function gapText(ms: number) {
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'less than a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h < 24) return m && h < 6 ? `${h} h ${m} min` : `${Math.round(min / 60)} h`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

/** "Saturday, May 18, 2024, 8:20 AM" for one photo, the day for one day, else the months. */
function whenText(items: MediaItem[]) {
  if (!items.length) return ''
  let first = Infinity
  let last = -Infinity
  for (const it of items) {
    if (it.date < first) first = it.date
    if (it.date > last) last = it.date
  }
  if (new Date(first).toDateString() !== new Date(last).toDateString()) return formatRange(items)
  return items.length === 1 ? `${formatLongDate(first)}, ${formatTime(first)}` : formatLongDate(first)
}

const placeTitle = (p: { name: string }) => p.name
const placeSub = (p: { admin: string; country: string }) => [p.admin, p.country].filter(Boolean).join(', ')
const coordsText = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`

const PIN_HTML =
  '<svg class="locd-pin" width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 38.5S27.5 25.7 27.5 15A12.5 12.5 0 0 0 2.5 15c0 10.7 12.5 23.5 12.5 23.5z"/><circle cx="15" cy="15" r="4.6"/></svg>'

export function LocationDialog({ items, byId, suggest, search, describe, onSave, onCancel, thumb = thumbUrl, onOpenUrl }: LocationDialogProps) {
  const [hours, setHours] = useState(3)
  const [sugg, setSugg] = useState<LocationSuggestions | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PlaceHit[]>([])
  const [searching, setSearching] = useState(false)
  const [showHits, setShowHits] = useState(false)
  const [active, setActive] = useState(0)
  const [choice, setChoice] = useState<Choice | null>(null)
  const touched = useRef(false) // the user picked something: suggestions no longer preselect
  const inputRef = useRef<HTMLInputElement>(null)

  const single = items.length === 1 ? items[0] : null
  const current = single && hasPosition(single) ? { lat: single.meta!.lat!, lon: single.meta!.lon! } : null
  const located = items.filter(hasPosition).length
  const jpegs = items.filter((it) => JPEG.has(it.ext.toLowerCase())).length
  // Keyed on the ids themselves: `items` is a new array on every render of the window (up to every
  // half second while Lumen works in the background), and a new set would move the map back each time.
  const idKey = items.map((it) => it.id).join('\n')
  const ids = useMemo(() => new Set(idKey ? idKey.split('\n') : []), [idKey])

  // ---------- suggestions ----------
  const suggestSeq = useRef(0)
  useEffect(() => {
    const seq = ++suggestSeq.current
    setLoading(true)
    suggest(hours)
      .then((res) => {
        if (seq !== suggestSeq.current) return
        setSugg(res)
        setLoading(false)
        if (touched.current) return
        const main = res.suggestions.filter((s) => !s.alternative)
        if (main.length === 1) pickSuggestion(main[0], false)
        else if (main.length > 1) setChoice({ kind: 'matched' })
        else setChoice(null)
      })
      .catch(() => {
        if (seq === suggestSeq.current) setLoading(false)
      })
    // re-run only when the time window changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hours])

  const main = sugg?.suggestions.filter((s) => !s.alternative) ?? []
  const alternatives = sugg?.suggestions.filter((s) => s.alternative) ?? []
  const matchedCount = sugg ? Object.keys(sugg.perItem).filter((id) => ids.has(id)).length : 0

  function pickSuggestion(s: LocationSuggestion, user = true) {
    if (user) touched.current = true
    setChoice({ kind: 'point', lat: s.lat, lon: s.lon, title: placeTitle(s), sub: placeSub(s), key: s.id, zoom: 13 })
  }

  // ---------- search ----------
  const searchSeq = useRef(0)
  const searchRef = useRef(search) // callbacks may be new functions on every render
  searchRef.current = search
  useEffect(() => {
    const q = query.trim()
    const seq = ++searchSeq.current
    if (q.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      searchRef
        .current(q)
        .then((res) => {
          if (seq !== searchSeq.current) return
          setHits(res)
          setActive(0)
          setSearching(false)
        })
        .catch(() => seq === searchSeq.current && setSearching(false))
    }, 140)
    return () => clearTimeout(timer)
  }, [query])

  const pickHit = (h: PlaceHit) => {
    touched.current = true
    setShowHits(false)
    setChoice({
      kind: 'point',
      lat: h.lat,
      lon: h.lon,
      title: h.coordinates ? (h.admin || 'Coordinates') : h.name,
      sub: h.coordinates ? coordsText(h.lat, h.lon) : placeSub(h),
      key: `hit:${h.cc}:${h.lat},${h.lon}`,
      zoom: h.coordinates ? 15 : h.pop > 500_000 ? 11 : h.pop > 50_000 ? 12 : 13,
    })
  }

  // ---------- a point picked on the map: named after its town ----------
  const describeSeq = useRef(0)
  const pickPoint = (lat: number, lon: number) => {
    touched.current = true
    const seq = ++describeSeq.current
    const key = `map:${lat},${lon}`
    setChoice({ kind: 'point', lat, lon, title: 'Picked on the map', sub: coordsText(lat, lon), key })
    describe(lat, lon)
      .then((d) => {
        if (seq !== describeSeq.current || !d) return
        const title = d.km > 3 ? `Near ${d.name}` : d.name
        setChoice((c) => (c?.kind === 'point' && c.key === key ? { ...c, title, sub: placeSub(d) } : c))
      })
      .catch(() => {})
  }

  // ---------- the map ----------
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const pinRef = useRef<L.Marker | null>(null)
  const overlayRef = useRef<L.LayerGroup | null>(null)
  const pickPointRef = useRef(pickPoint)
  pickPointRef.current = pickPoint
  const fittedRef = useRef(false)
  /** The choice and suggestions the map was last moved for (it only moves again when they change). */
  const movedFor = useRef<{ sugg: LocationSuggestions | null; choice: Choice | null } | null>(null)

  useEffect(() => {
    const map = createBaseMap(mapEl.current!, { onOpenUrl })
    mapRef.current = map
    if (current) map.setView([current.lat, current.lon], 13, { animate: false })
    else map.setView([25, 10], 2, { animate: false })
    overlayRef.current = L.layerGroup().addTo(map)
    const pin = L.marker(current ? [current.lat, current.lon] : [0, 0], {
      icon: L.divIcon({ html: PIN_HTML, className: 'locd-pin-icon', iconSize: [30, 40], iconAnchor: [15, 39] }),
      draggable: true,
      autoPan: true,
      keyboard: false,
      zIndexOffset: 1000,
    })
    if (current) pin.addTo(map)
    pin.on('dragend', () => {
      const p = pin.getLatLng().wrap()
      pickPointRef.current(p.lat, p.lng)
    })
    pinRef.current = pin
    map.on('click', (e: L.LeafletMouseEvent) => {
      const p = e.latlng.wrap()
      pickPointRef.current(p.lat, p.lng)
    })
    return () => {
      map.remove()
      mapRef.current = null
      pinRef.current = null
      overlayRef.current = null
      fittedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // suggestion dots, matched positions, the pin
  useEffect(() => {
    const map = mapRef.current
    const overlay = overlayRef.current
    const pin = pinRef.current
    if (!map || !overlay || !pin) return
    const move = !movedFor.current || movedFor.current.sugg !== sugg || movedFor.current.choice !== choice
    movedFor.current = { sugg, choice }
    overlay.clearLayers()
    const points: L.LatLngExpression[] = []
    if (choice?.kind === 'matched' && sugg) {
      for (const [id, p] of Object.entries(sugg.perItem)) {
        if (!ids.has(id)) continue
        L.circleMarker([p.lat, p.lon], { radius: 6, className: 'locd-dot matched', weight: 2, fillOpacity: 1 }).addTo(overlay)
        points.push([p.lat, p.lon])
      }
    }
    for (const s of sugg?.suggestions ?? []) {
      const on = choice?.kind === 'point' && choice.key === s.id
      if (on) continue
      const dot = L.circleMarker([s.lat, s.lon], { radius: 7, className: `locd-dot${s.alternative ? ' alt' : ''}`, weight: 2.5, fillOpacity: 1 })
      dot.bindTooltip(placeTitle(s), { direction: 'top', offset: [0, -6], className: 'locd-tip' })
      dot.on('click', (e) => {
        L.DomEvent.stopPropagation(e)
        pickSuggestion(s)
      })
      dot.addTo(overlay)
      if (choice?.kind !== 'point') points.push([s.lat, s.lon])
    }
    if (choice?.kind === 'point') {
      pin.setLatLng([choice.lat, choice.lon])
      if (!map.hasLayer(pin)) pin.addTo(map)
      if (choice.zoom && move) {
        // a searched town: its own zoom; a suggestion: closer if the map isn't already
        const zoom = choice.key.startsWith('hit:') ? choice.zoom : Math.max(choice.zoom, Math.min(map.getZoom(), 16))
        map.setView([choice.lat, choice.lon], zoom, { animate: fittedRef.current })
      }
      fittedRef.current = true
    } else {
      if (!current && map.hasLayer(pin)) pin.remove()
      if (points.length && move) {
        map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 13, animate: fittedRef.current })
        fittedRef.current = true
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sugg, choice, ids])

  // ---------- keys & save ----------
  const canSave = choice?.kind === 'point' || (choice?.kind === 'matched' && matchedCount > 0)
  const save = () => {
    if (!choice) return
    if (choice.kind === 'point') {
      onSave(
        items.map((it) => ({ id: it.id, lat: choice.lat, lon: choice.lon })),
        [choice.title.replace(/^Picked on the map$/, ''), choice.sub].filter(Boolean).join(', ') || coordsText(choice.lat, choice.lon),
      )
    } else if (sugg) {
      const list = Object.entries(sugg.perItem)
        .filter(([id]) => ids.has(id))
        .map(([id, p]) => ({ id, lat: p.lat, lon: p.lon }))
      const names = main.map((s) => s.name)
      onSave(list, names.length > 2 ? `${names[0]} and ${names.length - 1} more places` : names.join(' and '))
    }
  }
  useDialogKeys((e) => {
    if (e.key === 'Escape') {
      if (showHits && hits.length) setShowHits(false)
      else onCancel()
    } else if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest?.('input, select, button') && canSave) {
      save()
    }
  })

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setShowHits(true)
      setActive((a) => Math.min(a + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault()
      pickHit(hits[active])
    }
  }

  // ---------- text ----------
  const what = summarize(items)
  const when = whenText(items)
  const note =
    jpegs === items.length
      ? 'The location is saved in the photo files (without re-saving the pictures). You can undo it in History.'
      : jpegs === 0
        ? `Lumen remembers the location for ${items.length === 1 ? 'this file' : 'these files'}: ${items.length === 1 ? 'its' : 'their'} format can't hold one without re-saving.`
        : `JPEG photos get it saved in the file; Lumen remembers it for the other ${formatCount(items.length - jpegs)}. You can undo it in History.`

  const sourceThumbs = (s: LocationSuggestion) =>
    s.sources
      .map((id) => byId.get(id))
      .filter((it): it is MediaItem => !!it)
      .slice(0, 3)

  const why = (s: LocationSuggestion) => {
    if (s.alternative) return `Also photographed here within ${gapText(s.gap)}`
    if (single) {
      const src = byId.get(s.sources[0])
      const before = src ? src.date <= single.date : true
      return `A photo here was taken ${gapText(s.gap)} ${before ? 'before' : 'after'}`
    }
    return `Closest match for ${formatCount(s.targets.length)} of ${formatCount(items.length)} · ${gapText(s.gap)} apart`
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal locd" role="dialog" aria-modal="true" aria-label="Add location" onMouseDown={(e) => e.stopPropagation()}>
        <div className="locd-side">
          <div className="locd-head">
            <div className="locd-titles">
              <h3>{located === items.length && items.length ? 'Change location' : 'Add location'}</h3>
              <p>
                {what}
                {when ? ` · ${when}` : ''}
              </p>
            </div>
            <button className="icon-btn" onClick={onCancel} aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="locd-strip">
            {items.slice(0, 7).map((it, i) => (
              <div key={it.id} className="locd-strip-cell" title={it.name}>
                <img src={thumb(it)} alt="" draggable={false} />
                {i === 6 && items.length > 7 && <span>+{formatCount(items.length - 6)}</span>}
              </div>
            ))}
          </div>

          <div className="locd-search-wrap">
            <div className="locd-search">
              <Search size={15} />
              <input
                ref={inputRef}
                value={query}
                placeholder="Search for a town, or type coordinates"
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setShowHits(true)
                }}
                onFocus={() => setShowHits(true)}
                onBlur={() => setTimeout(() => setShowHits(false), 150)}
                onKeyDown={onSearchKey}
              />
              {searching && <LoaderCircle size={15} className="spin" />}
              {query && !searching && (
                <button
                  className="icon-btn tiny"
                  aria-label="Clear"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQuery('')
                    inputRef.current?.focus()
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {showHits && query.trim().length >= 2 && !searching && (
              <div className="locd-hits" role="listbox">
                {hits.length ? (
                  hits.map((h, i) => (
                    <button
                      key={`${h.name}|${h.admin}|${h.cc}|${i}`}
                      className={`locd-hit${i === active ? ' active' : ''}`}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pickHit(h)}
                    >
                      {h.coordinates ? <Crosshair size={15} /> : <MapPin size={15} />}
                      <span className="locd-hit-name">{h.name}</span>
                      <span className="locd-hit-sub">{placeSub(h)}</span>
                    </button>
                  ))
                ) : (
                  <div className="locd-hits-empty">No town called “{query.trim()}”. Try another spelling, or click the map.</div>
                )}
              </div>
            )}
          </div>

          <div className="locd-section">
            <Sparkles size={14} />
            <span>From photos taken within</span>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Time window">
              {WINDOWS.map((h) => (
                <option key={h} value={h}>
                  {h === 24 ? '1 day' : `${h} hour${h === 1 ? '' : 's'}`}
                </option>
              ))}
            </select>
          </div>

          <div className="locd-list">
            {loading && !sugg ? (
              <div className="locd-empty">
                <LoaderCircle size={16} className="spin" /> Looking at photos taken around the same time…
              </div>
            ) : !sugg?.suggestions.length ? (
              <div className="locd-empty">
                No photo with a location was taken within {hours === 24 ? 'a day' : `${hours} hour${hours === 1 ? '' : 's'}`} of {items.length === 1 ? 'this one' : 'these'}. Try a longer time, search for the place, or click the map.
              </div>
            ) : (
              <>
                {main.length > 1 && (
                  <button className={`locd-sugg${choice?.kind === 'matched' ? ' on' : ''}`} onClick={() => {
                      touched.current = true
                      setChoice({ kind: 'matched' })
                    }}>
                    <span className="locd-sugg-icon">
                      <Sparkles size={16} />
                    </span>
                    <span className="locd-sugg-text">
                      <span className="locd-sugg-name">Match each by time</span>
                      <span className="locd-sugg-why">
                        {formatCount(matchedCount)} of {formatCount(items.length)} get the place of the photo taken closest in time
                      </span>
                    </span>
                  </button>
                )}
                {main.map((s) => (
                  <SuggestionRow key={s.id} s={s} on={choice?.kind === 'point' && choice.key === s.id} why={why(s)} thumbs={sourceThumbs(s)} thumb={thumb} onPick={() => pickSuggestion(s)} />
                ))}
                {alternatives.length > 0 && <div className="locd-sub-head">Also around that time</div>}
                {alternatives.map((s) => (
                  <SuggestionRow key={s.id} s={s} on={choice?.kind === 'point' && choice.key === s.id} why={why(s)} thumbs={sourceThumbs(s)} thumb={thumb} onPick={() => pickSuggestion(s)} />
                ))}
                {loading && (
                  <div className="locd-empty small">
                    <LoaderCircle size={14} className="spin" /> Updating…
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="locd-main">
          <div className="locd-map-wrap">
            <div ref={mapEl} className="lmap locd-map" />
            <div className="locd-map-hint">Click the map or drag the pin</div>
          </div>
          <div className="locd-where">
            <MapPin size={18} />
            {choice?.kind === 'point' ? (
              <div className="locd-where-text">
                <b>{choice.title}</b>
                <span>{[choice.sub, choice.sub === coordsText(choice.lat, choice.lon) ? '' : coordsText(choice.lat, choice.lon)].filter(Boolean).join(' · ')}</span>
              </div>
            ) : choice?.kind === 'matched' ? (
              <div className="locd-where-text">
                <b>Each gets its own place</b>
                <span>
                  {formatCount(matchedCount)} of {formatCount(items.length)} matched
                  {matchedCount < items.length ? ` · ${formatCount(items.length - matchedCount)} stay without a location` : ''}
                </span>
              </div>
            ) : current ? (
              <div className="locd-where-text">
                <b>Current location</b>
                <span>{coordsText(current.lat, current.lon)}</span>
              </div>
            ) : (
              <div className="locd-where-text muted">
                <b>No place chosen yet</b>
                <span>Pick a suggestion, search, or click the map</span>
              </div>
            )}
          </div>
          <div className="locd-foot">
            <p className="locd-note">
              {note}
              {located > 0 && !(single && current) ? ` ${formatCount(located)} already ${located === 1 ? 'has' : 'have'} a location; it will be replaced.` : ''}
            </p>
            <div className="locd-actions">
              <button className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn primary" disabled={!canSave} onClick={save}>
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SuggestionRow({
  s,
  on,
  why,
  thumbs,
  thumb,
  onPick,
}: {
  s: LocationSuggestion
  on: boolean
  why: string
  thumbs: MediaItem[]
  thumb: (item: MediaItem) => string
  onPick(): void
}) {
  const low = s.confidence === 'low' || s.gap > 6 * HOUR
  return (
    <button className={`locd-sugg${on ? ' on' : ''}${s.alternative ? ' alt' : ''}`} onClick={onPick} title={`${s.name}${placeSub(s) ? `, ${placeSub(s)}` : ''}`}>
      <span className="locd-sugg-icon">
        <MapPin size={16} />
      </span>
      <span className="locd-sugg-text">
        <span className="locd-sugg-name">{s.name}</span>
        <span className="locd-sugg-sub">{placeSub(s)}</span>
        <span className={`locd-sugg-why${low ? ' low' : ''}`}>{why}</span>
      </span>
      <span className="locd-sugg-thumbs">
        {thumbs.map((it) => (
          <img key={it.id} src={thumb(it)} alt="" draggable={false} title={it.name} />
        ))}
      </span>
    </button>
  )
}
