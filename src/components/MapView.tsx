import L from 'leaflet'
import 'leaflet.markercluster'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import { Images, MapPin, Maximize, PanelRightClose, PanelRightOpen, X, ZoomIn } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { thumbUrl } from '../api'
import { formatCount, formatRange, summarize } from '../lib/format'
import type { MediaItem } from '../types'
import './map.css'

/**
 * The map: every photo and video with a GPS position as a thumbnail pin, clustered (a cluster
 * shows its newest photo and how many it holds). Clicking a cluster shows a card with its photos
 * ("Show all" / "Zoom in"); clicking a single photo opens it. Full page it has an "In this area"
 * panel listing what's in view; `compact` makes a small embedded map (trip page). Props-driven:
 * it never talks to IPC itself.
 *
 * Map images are OpenStreetMap's standard tiles, loaded only for what's on screen and cached by
 * Chromium's HTTP cache (OSM tile usage policy: no prefetching, zoom ≤ 19, attribution shown).
 */

// ---------- shared with LocationDialog ----------

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const MAX_ZOOM = 19

type Thumb = (item: MediaItem) => string

/** Has a usable position (0,0 is what broken GPS writes). */
export const hasPosition = (it: MediaItem) => {
  const la = it.meta?.lat
  const lo = it.meta?.lon
  return la !== undefined && lo !== undefined && Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0)
}

/**
 * A Leaflet map in `el` with OpenStreetMap tiles, a zoom control and the attribution. Links in it
 * go to `onOpenUrl` (the app window never navigates). `compact`: the mouse wheel zooms only once
 * the map has been clicked, so a page around it still scrolls. Follows the element's size.
 */
export function createBaseMap(el: HTMLElement, { compact = false, onOpenUrl }: { compact?: boolean; onOpenUrl?: (url: string) => void } = {}) {
  const map = L.map(el, {
    zoomControl: false,
    attributionControl: false,
    minZoom: 2,
    maxZoom: MAX_ZOOM,
    worldCopyJump: true,
    scrollWheelZoom: !compact,
    wheelPxPerZoomLevel: 90,
  })
  L.control.zoom({ position: 'topleft', zoomInTitle: 'Zoom in', zoomOutTitle: 'Zoom out' }).addTo(map)
  L.control.attribution({ position: 'bottomright', prefix: '<a href="https://leafletjs.com">Leaflet</a>' }).addTo(map)
  L.tileLayer(TILE_URL, {
    maxZoom: MAX_ZOOM,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    updateWhenZooming: false, // fewer tile requests while zooming
    keepBuffer: 2,
  }).addTo(map)
  if (compact) {
    map.on('focus', () => map.scrollWheelZoom.enable())
    map.on('blur', () => map.scrollWheelZoom.disable())
  }
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[href^="http"]') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    onOpenUrl?.(a.href)
  }
  el.addEventListener('click', onClick)
  const resize = new ResizeObserver(() => map.invalidateSize({ pan: false }))
  resize.observe(el)
  map.on('unload', () => {
    resize.disconnect()
    el.removeEventListener('click', onClick)
  })
  return map
}

// ---------- thumbnail pins ----------

/** The pin: a framed thumbnail (a small stack for clusters) with a count badge. */
function thumbElement(item: MediaItem | undefined, thumb: Thumb, size: number, count: number) {
  const box = document.createElement('div')
  box.className = 'lmap-thumb'
  box.style.width = box.style.height = `${size}px`
  if (item) {
    const img = document.createElement('img')
    img.alt = ''
    img.draggable = false
    img.decoding = 'async'
    img.src = thumb(item)
    img.onerror = () => img.remove()
    box.append(img)
    if (item.type === 'video' && count <= 1) {
      const v = document.createElement('span')
      v.className = 'lmap-video'
      box.append(v)
    }
  }
  if (count > 1) {
    const badge = document.createElement('span')
    badge.className = 'lmap-count'
    badge.textContent = count >= 10_000 ? `${Math.round(count / 1000)}k` : count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(count)
    box.append(badge)
  }
  return box
}

interface ThumbIconOptions extends L.DivIconOptions {
  item?: MediaItem
  thumb: Thumb
  size: number
  count: number
}

// The element is built only when Leaflet shows the pin (15k pins never exist at once).
const ThumbIcon: new (options: ThumbIconOptions) => L.DivIcon = (L.DivIcon as unknown as { extend(props: object): never }).extend({
  createIcon(this: { options: ThumbIconOptions; _setIconStyles(el: HTMLElement, name: string): void }) {
    const o = this.options
    const el = document.createElement('div')
    el.append(thumbElement(o.item, o.thumb, o.size, o.count))
    this._setIconStyles(el, 'icon')
    return el
  },
  createShadow() {
    return null
  },
})

const clusterSize = (count: number, compact: boolean) => (compact ? 38 : 50) + (count < 10 ? 0 : count < 100 ? 5 : count < 1000 ? 10 : 15)

/** Newest photo first (a video only if there are no photos), like Places' covers. */
const better = (a: MediaItem, b: MediaItem) => (a.type === 'image') !== (b.type === 'image') ? a.type === 'image' : a.date > b.date

const byNewest = (a: MediaItem, b: MediaItem) => b.date - a.date

// ---------- the view ----------

export interface MapViewState {
  lat: number
  lon: number
  zoom: number
}

export interface MapViewProps {
  /** What to show; items without a position are left out. */
  items: MediaItem[]
  /** Small embedded map (trip page): smaller pins, no side panel, wheel zoom after a click. */
  compact?: boolean
  /** Height of a compact map (default 260 px). */
  height?: number | string
  /** Fit the view to the items again whenever this changes (e.g. a trip id). */
  fitKey?: string | number
  /** Where to start (e.g. kept from the last visit) instead of fitting to the items. */
  initialView?: MapViewState | null
  /** The view moved (debounced): for keeping it across visits. */
  onViewChange?(view: MapViewState): void
  /** Show the "In this area" panel (default: when not compact). Uncontrolled after the start. */
  showPanel?: boolean
  /** A cluster's "Show all", or the panel's: the items, newest first, and a title for them. */
  onOpen(ids: string[], label: string): void
  /** One photo clicked: open it, with `ids` (newest first) to page through. */
  onOpenItem(id: string, ids: string[]): void
  /** Cluster click opens its photos at once (onOpen) instead of the card. */
  directOpen?: boolean
  /** A title for a group of items, e.g. its main place ("Paris, France"). */
  labelFor?(ids: string[]): string | null
  /** Thumbnail URL (default: the app's gallery://thumb). */
  thumb?: Thumb
  /** Links in the map (OpenStreetMap copyright): open in the browser. */
  onOpenUrl?(url: string): void
  /** Text when no item has a position. */
  emptyText?: string
  className?: string
}

interface Card {
  ids: string[]
  latlng: L.LatLng
  size: number
  bounds: L.LatLngBounds | null
}

const PANEL_LIMIT = 150

export function MapView(props: MapViewProps) {
  const { items, compact = false, height, fitKey, thumb = thumbUrl, emptyText, className } = props
  const latest = useRef(props)
  latest.current = props
  const thumbRef = useRef(thumb)
  thumbRef.current = thumb

  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const groupRef = useRef<L.MarkerClusterGroup | null>(null)
  const popupRef = useRef<L.Popup | null>(null)
  const markers = useRef(new Map<string, { marker: L.Marker; lat: number; lon: number }>())
  const idOf = useRef(new WeakMap<L.Layer, string>())
  const fitted = useRef<unknown>(undefined)
  const [cardEl] = useState(() => document.createElement('div'))
  const [card, setCard] = useState<Card | null>(null)
  const [panel, setPanel] = useState(props.showPanel ?? !compact)
  const [inView, setInView] = useState<MediaItem[] | null>(null)
  const [loading, setLoading] = useState(0) // 0–1 while pins are being placed
  const [mapReady, setMapReady] = useState(0)

  const located = useMemo(() => items.filter(hasPosition), [items])
  const byId = useMemo(() => new Map(located.map((it) => [it.id, it])), [located])
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  const panelRef = useRef(panel)
  panelRef.current = panel

  /** Items under a set of markers, newest first. */
  const sortIds = (ids: string[]) => {
    const map = byIdRef.current
    return ids
      .map((id) => map.get(id))
      .filter((it): it is MediaItem => !!it)
      .sort(byNewest)
      .map((it) => it.id)
  }

  const updateInView = () => {
    const map = mapRef.current
    if (!map) return
    if (!panelRef.current) return setInView(null)
    const b = map.getBounds()
    const s = b.getSouth()
    const n = b.getNorth()
    const w = b.getWest()
    const e = b.getEast()
    const all = e - w >= 360
    const list: MediaItem[] = []
    for (const it of byIdRef.current.values()) {
      const la = it.meta!.lat!
      const lo = it.meta!.lon!
      if (la < s || la > n) continue
      if (all || (lo >= w && lo <= e) || (lo + 360 >= w && lo + 360 <= e) || (lo - 360 >= w && lo - 360 <= e)) list.push(it)
    }
    setInView(list.sort(byNewest))
  }
  const updateRef = useRef(updateInView)
  updateRef.current = updateInView

  // ---------- the map (once) ----------
  useEffect(() => {
    const el = elRef.current!
    const map = createBaseMap(el, { compact, onOpenUrl: (url) => latest.current.onOpenUrl?.(url) })
    mapRef.current = map
    const start = latest.current.initialView
    if (start && Number.isFinite(start.lat) && Number.isFinite(start.lon)) {
      map.setView([start.lat, start.lon], start.zoom, { animate: false })
      fitted.current = latest.current.fitKey ?? null
    } else {
      map.setView([25, 10], 2, { animate: false })
    }

    // the cover of a cluster: cached per cluster (its photos only change when the items do)
    const covers = new WeakMap<L.MarkerCluster, { count: number; item: MediaItem | undefined }>()
    const coverOf = (cluster: L.MarkerCluster) => {
      const count = cluster.getChildCount()
      const cached = covers.get(cluster)
      if (cached && cached.count === count) return cached.item
      let best: MediaItem | undefined
      for (const m of cluster.getAllChildMarkers()) {
        const it = byIdRef.current.get(idOf.current.get(m) ?? '')
        if (it && (!best || better(it, best))) best = it
      }
      covers.set(cluster, { count, item: best })
      return best
    }

    const group = L.markerClusterGroup({
      chunkedLoading: true,
      chunkInterval: 120,
      chunkDelay: 16,
      chunkProgress: (done: number, total: number) => setLoading(done >= total ? 0 : done / total),
      showCoverageOnHover: false,
      zoomToBoundsOnClick: false,
      spiderfyOnMaxZoom: false,
      removeOutsideVisibleBounds: true,
      maxClusterRadius: compact ? 56 : 80,
      iconCreateFunction: (cluster: L.MarkerCluster) => {
        const count = cluster.getChildCount()
        const size = clusterSize(count, compact)
        return new ThumbIcon({ item: coverOf(cluster), thumb: (it) => thumbRef.current(it), size, count, iconSize: [size, size], className: 'lmap-cluster' })
      },
    })
    groupRef.current = group
    map.addLayer(group)

    group.on('clusterclick', (e: L.LeafletEvent) => {
      const cluster = (e as unknown as { layer: L.MarkerCluster }).layer
      const ids = sortIds(cluster.getAllChildMarkers().map((m) => idOf.current.get(m) ?? ''))
      const p = latest.current
      if (p.directOpen) return p.onOpen(ids, p.labelFor?.(ids) ?? summarize(ids.map((id) => byIdRef.current.get(id)!)))
      const bounds = cluster.getBounds()
      const spread = !bounds.getNorthEast().equals(bounds.getSouthWest(), 1e-7)
      setCard({ ids, latlng: cluster.getLatLng(), size: clusterSize(ids.length, compact), bounds: spread ? bounds : null })
    })
    group.on('click', (e: L.LeafletEvent) => {
      const id = idOf.current.get((e as unknown as { layer: L.Layer }).layer)
      if (!id) return
      // the viewer pages through what's in view
      const b = map.getBounds()
      const near = [...byIdRef.current.values()].filter((it) => b.contains([it.meta!.lat!, it.meta!.lon!])).sort(byNewest).map((it) => it.id)
      latest.current.onOpenItem(id, near.includes(id) ? near : [id])
    })

    const popup = L.popup({ className: 'lmap-popup', closeButton: false, autoPanPadding: L.point(24, 24), maxWidth: 340, minWidth: 200 })
    popupRef.current = popup
    map.on('popupclose', () => setCard(null))
    map.on('zoomstart', () => map.closePopup())

    let viewTimer: ReturnType<typeof setTimeout> | undefined
    map.on('moveend', () => {
      updateRef.current()
      clearTimeout(viewTimer)
      viewTimer = setTimeout(() => {
        const c = map.getCenter()
        latest.current.onViewChange?.({ lat: c.lat, lon: c.wrap().lng, zoom: map.getZoom() })
      }, 300)
    })
    setMapReady((n) => n + 1)

    return () => {
      clearTimeout(viewTimer)
      map.remove()
      mapRef.current = null
      groupRef.current = null
      popupRef.current = null
      // the pins went with the map: forget them (markers.current is replaced on every update, so
      // the Map from when the map was made would be the wrong one to clear)
      markers.current = new Map()
      fitted.current = undefined
    }
    // created once; later prop changes are read through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- pins follow the items (only the changes are applied) ----------
  useEffect(() => {
    const group = groupRef.current
    const map = mapRef.current
    if (!group || !map) return
    const known = markers.current
    const next = new Map<string, { marker: L.Marker; lat: number; lon: number }>()
    const add: L.Marker[] = []
    const remove: L.Marker[] = []
    const size = compact ? 34 : 44
    for (const it of located) {
      const lat = it.meta!.lat!
      const lon = it.meta!.lon!
      const prev = known.get(it.id)
      if (prev && prev.lat === lat && prev.lon === lon) {
        next.set(it.id, prev)
        continue
      }
      if (prev) remove.push(prev.marker)
      const marker = L.marker([lat, lon], {
        icon: new ThumbIcon({ item: it, thumb: (x) => thumbRef.current(x), size, count: 1, iconSize: [size, size], className: 'lmap-marker' }),
        keyboard: false,
        riseOnHover: true,
      })
      idOf.current.set(marker, it.id)
      next.set(it.id, { marker, lat, lon })
      add.push(marker)
    }
    for (const [id, m] of known) if (!next.has(id)) remove.push(m.marker)
    markers.current = next
    if (remove.length) group.removeLayers(remove)
    if (add.length) group.addLayers(add)
    // a refreshed item (new preview) keeps its pin; refresh the cluster covers
    if (!add.length && !remove.length) group.refreshClusters()

    const key = fitKey ?? null
    if (located.length && fitted.current !== key) {
      fitted.current = key
      fitTo(map, located)
    }
    updateRef.current()
  }, [located, fitKey, compact, mapReady])

  // the panel follows the view
  useEffect(() => {
    updateRef.current()
    mapRef.current?.invalidateSize({ pan: false })
  }, [panel])

  // ---------- the card ----------
  useEffect(() => {
    const map = mapRef.current
    const popup = popupRef.current
    if (!map || !popup) return
    if (!card) {
      if (map.hasLayer(popup)) map.closePopup(popup)
      return
    }
    popup.options.offset = L.point(0, -Math.round(card.size / 2) - 6)
    popup.setLatLng(card.latlng).setContent(cardEl)
    if (!map.hasLayer(popup)) popup.openOn(map)
  }, [card, cardEl])
  useLayoutEffect(() => {
    if (card) popupRef.current?.update()
  }, [card])

  const fitAll = () => {
    const map = mapRef.current
    if (map && located.length) fitTo(map, located, true)
  }

  const cardItems = card ? card.ids.map((id) => byId.get(id)).filter((it): it is MediaItem => !!it) : []
  const cardLabel = card ? (props.labelFor?.(card.ids) ?? null) : null
  const panelItems = inView ?? []
  const panelLabel = panelItems.length ? (props.labelFor?.(panelItems.map((it) => it.id)) ?? 'In this area') : 'In this area'

  return (
    <div
      className={`lmap-wrap${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}
      style={compact && height !== undefined ? ({ '--lmap-h': typeof height === 'number' ? `${height}px` : height } as CSSProperties) : undefined}
    >
      <div className="lmap-stage">
        <div ref={elRef} className="lmap" />
        {loading > 0 && <div className="lmap-progress" style={{ width: `${Math.round(loading * 100)}%` }} />}
        <div className="lmap-tools">
          {located.length > 0 && (
            <button className="lmap-tool" onClick={fitAll} title="Show all photos">
              <Maximize size={16} />
            </button>
          )}
          {!compact && (
            <button className={`lmap-tool${panel ? ' on' : ''}`} onClick={() => setPanel((v) => !v)} title={panel ? 'Hide the photo list' : 'Show the photos in this area'}>
              {panel ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          )}
        </div>
        {!located.length && (
          <div className="lmap-empty">
            <div>
              <MapPin size={compact ? 18 : 30} strokeWidth={1.6} />
              <h3>{compact ? (emptyText ?? 'No photos with a location') : 'No locations yet'}</h3>
              {!compact && (
                <p>{emptyText ?? 'Photos and videos that recorded where they were taken show up on the map. You can add a place to others with “Add location”.'}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {!compact && panel && (
        <aside className="lmap-panel">
          <div className="lmap-panel-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 title={panelLabel}>{panelLabel}</h3>
              <span>{panelItems.length ? summarize(panelItems) : 'Nothing here'}</span>
            </div>
            {panelItems.length > 0 && (
              <button className="btn ghost" onClick={() => props.onOpen(panelItems.map((it) => it.id), panelLabel)}>
                Show all
              </button>
            )}
          </div>
          {panelItems.length ? (
            <div className="lmap-panel-scroll">
              <div className="lmap-panel-grid">
                {panelItems.slice(0, PANEL_LIMIT).map((it) => (
                  <button
                    key={it.id}
                    className="lmap-cell"
                    title={it.name}
                    onClick={() =>
                      props.onOpenItem(
                        it.id,
                        panelItems.map((x) => x.id),
                      )
                    }
                  >
                    <img src={thumb(it)} alt="" loading="lazy" draggable={false} />
                    {it.type === 'video' && <span className="lmap-video" />}
                  </button>
                ))}
              </div>
              {panelItems.length > PANEL_LIMIT && (
                <div className="lmap-panel-more">
                  <button className="link" onClick={() => props.onOpen(panelItems.map((it) => it.id), panelLabel)}>
                    Show all {formatCount(panelItems.length)}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="lmap-panel-empty">{located.length ? 'Move or zoom out the map to see photos here.' : 'No photos with a location.'}</div>
          )}
        </aside>
      )}

      {card &&
        createPortal(
          <div className="lmap-card">
            <div className="lmap-card-head">
              <div className="lmap-card-titles">
                <div className="lmap-card-title">{cardLabel ?? summarize(cardItems)}</div>
                <div className="lmap-card-sub">{cardLabel ? `${summarize(cardItems)} · ${formatRange(cardItems)}` : formatRange(cardItems)}</div>
              </div>
              <button className="icon-btn tiny" onClick={() => setCard(null)} aria-label="Close">
                <X size={15} />
              </button>
            </div>
            <div className="lmap-card-grid">
              {cardItems.slice(0, 6).map((it, i) => (
                <button key={it.id} className="lmap-cell" title={it.name} onClick={() => props.onOpenItem(it.id, card.ids)}>
                  <img src={thumb(it)} alt="" draggable={false} />
                  {it.type === 'video' && <span className="lmap-video" />}
                  {i === 5 && cardItems.length > 6 && <span className="lmap-more">+{formatCount(cardItems.length - 5)}</span>}
                </button>
              ))}
            </div>
            <div className="lmap-card-actions">
              {card.bounds && (
                <button
                  className="btn ghost"
                  onClick={() => {
                    const map = mapRef.current
                    const bounds = card.bounds
                    setCard(null)
                    if (map && bounds) map.fitBounds(bounds, { padding: [60, 60], maxZoom: MAX_ZOOM })
                  }}
                >
                  <ZoomIn size={15} /> Zoom in
                </button>
              )}
              <button className="btn primary" onClick={() => props.onOpen(card.ids, cardLabel ?? summarize(cardItems))}>
                <Images size={15} /> Show all
              </button>
            </div>
          </div>,
          cardEl,
        )}
    </div>
  )
}

/** Fits the map to the items: their bounds, at most street level. */
function fitTo(map: L.Map, items: MediaItem[], animate = false) {
  let s = 90
  let n = -90
  let w = 180
  let e = -180
  for (const it of items) {
    const la = it.meta!.lat!
    const lo = it.meta!.lon!
    if (la < s) s = la
    if (la > n) n = la
    if (lo < w) w = lo
    if (lo > e) e = lo
  }
  map.fitBounds(
    [
      [s, w],
      [n, e],
    ],
    { padding: [56, 56], maxZoom: 15, animate },
  )
}
