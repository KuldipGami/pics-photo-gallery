import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { api } from './api'
import type { TagsData } from './components/RatingFilter'
import type {
  Album,
  DuplicatesData,
  DuplicatesProgress,
  HistoryEntry,
  MediaItem,
  PeopleData,
  PeopleProgress,
  PlacesData,
  ScanStatus,
  Settings,
  SmartProgress,
  ThumbProgress,
  VideosProgress,
} from './types'

export function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

const EMPTY_PEOPLE: PeopleData = { enabled: true, people: [], byItem: {}, analysed: 0, faces: 0 }
const EMPTY_DUPES: DuplicatesData = { groups: [], facts: {}, sensitivity: 90, findCrops: true }

/** Live view of the main-process library, settings, scan status, people, albums, places… */
export function useLibrary() {
  const [items, setItems] = useState<MediaItem[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState<ScanStatus>({ scanning: false, found: 0 })
  const [thumbProgress, setThumbProgress] = useState<ThumbProgress>({ pending: 0, total: 0 })
  const [version, setVersion] = useState('')
  const [people, setPeople] = useState<PeopleData>(EMPTY_PEOPLE)
  const [peopleProgress, setPeopleProgress] = useState<PeopleProgress>({ done: 0, total: 0, running: false, error: null })
  const [albums, setAlbums] = useState<Album[]>([])
  const [places, setPlaces] = useState<PlacesData>({ places: [], byItem: {} })
  const [dupes, setDupes] = useState<DuplicatesData>(EMPTY_DUPES)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [launch, setLaunch] = useState<{ folder?: string; duplicates?: boolean } | null>(null)
  const [tags, setTags] = useState<TagsData>({ byItem: {} })
  const [dupesProgress, setDupesProgress] = useState<DuplicatesProgress>({ running: false, phase: 'idle', done: 0, total: 0 })
  const [videosProgress, setVideosProgress] = useState<VideosProgress>({ running: false, done: 0, total: 0, current: null })
  const [smartProgress, setSmartProgress] = useState<SmartProgress>({
    done: 0,
    total: 0,
    running: false,
    indexed: 0,
    available: true,
    error: null,
    engine: null,
  })

  useEffect(() => {
    const offs = [
      api.onPeople(setPeople),
      api.onPeopleProgress(setPeopleProgress),
      api.onLibrary((p) => setItems(p.items)),
      api.onStatus(setStatus),
      api.onThumbProgress(setThumbProgress),
      api.onSettings(setSettings),
      api.onAlbums(setAlbums),
      api.onPlaces(setPlaces),
      api.onDuplicates(setDupes),
      api.onDuplicatesProgress(setDupesProgress),
      api.onVideosProgress(setVideosProgress),
      api.onSmartProgress(setSmartProgress),
      api.onHistory(setHistory),
      api.onTags(setTags),
    ]
    api.getState().then((s) => {
      setItems(s.items)
      setStatus(s.status)
      setSettings(s.settings)
      setVersion(s.version)
      setPeople(s.people)
      setPeopleProgress(s.peopleProgress)
      setAlbums(s.albums)
      setPlaces(s.places)
      setDupes(s.dupes)
      setDupesProgress(s.dupesProgress)
      setVideosProgress(s.videosProgress)
      setSmartProgress(s.smartProgress)
      setHistory(s.history)
      setLaunch(s.launch ?? null)
      setTags(s.tags ?? { byItem: {} })
    })
    return () => offs.forEach((off) => off())
  }, [])

  return {
    items,
    settings,
    setSettings,
    status,
    thumbProgress,
    version,
    people,
    peopleProgress,
    albums,
    places,
    dupes,
    dupesProgress,
    videosProgress,
    smartProgress,
    history,
    launch,
    tags,
  }
}

/**
 * Finds items by what's in them for each phrase (debounced). `matches` is phrase → item id → score
 * once results for exactly these phrases are in; until then `pending` is true.
 */
export function useSmartSearch(phrases: string[]) {
  const key = phrases.join('\n')
  const [result, setResult] = useState<{ key: string; matches: Map<string, Map<string, number>> } | null>(null)
  useEffect(() => {
    if (!key) return
    let live = true
    const t = setTimeout(async () => {
      const matches = new Map<string, Map<string, number>>()
      for (const phrase of key.split('\n')) {
        const res = await api.smartSearch(phrase)
        matches.set(phrase, new Map(res.ids.map((id, i) => [id, res.scores[i]])))
      }
      if (live) setResult({ key, matches })
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [key])
  const ready = !!key && result?.key === key
  return { matches: ready ? result.matches : null, pending: !!key && !ready }
}

/** Returns a stable function that always calls the latest `fn`. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R) {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}

export interface Toast {
  id: number
  text: string
  /** A button in the toast, e.g. Undo or Open folder. */
  action?: { label: string; run(): void }
  error?: boolean
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, opts: { action?: Toast['action']; error?: boolean } = {}) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, text, ...opts }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.action || opts.error ? 10_000 : 3200)
  }, [])
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  return { toasts, push, dismiss }
}
