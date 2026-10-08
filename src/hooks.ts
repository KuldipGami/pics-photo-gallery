import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { api, parseItems } from './api'
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
  OcrProgress,
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
/** How often background progress is shown at most (ms). */
const PROGRESS_MS = 500
/** Progress reports are small objects: equal JSON = nothing to show. */
const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
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
  const [ocrProgress, setOcrProgress] = useState<OcrProgress>({ done: 0, total: 0, running: false, indexed: 0, withText: 0, available: true, error: null, lang: null })
  /** Goes up whenever the text read in photos changes (to refresh searches and the details panel). */
  const [ocrVersion, setOcrVersion] = useState(0)
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
    // Background jobs report progress several times a second each, and every report re-rendered
    // the whole window. Reports are shown at most every PROGRESS_MS, all in one render, and a
    // report that changes nothing doesn't render at all.
    const pending = new Map<unknown, () => void>()
    let timer = 0
    const flush = () => {
      timer = 0
      const run = [...pending.values()]
      pending.clear()
      for (const fn of run) fn()
    }
    const later = (key: unknown, fn: () => void) => {
      pending.set(key, fn)
      if (!timer) timer = window.setTimeout(flush, PROGRESS_MS)
    }
    const progress =
      <T,>(set: (update: (prev: T) => T) => void) =>
      (next: T) =>
        later(set, () => set((prev) => (sameJson(prev, next) ? prev : next)))
    const offs = [
      api.onPeopleText((json) => setPeople(JSON.parse(json))),
      api.onPeopleProgress(progress(setPeopleProgress)),
      api.onLibraryText((p) => setItems(parseItems(p.items))),
      api.onStatus(setStatus), // (right away: "Looking for photos…" shouldn't wait)
      api.onThumbProgress(progress(setThumbProgress)),
      api.onSettings(setSettings),
      api.onAlbums(setAlbums),
      api.onPlaces(setPlaces),
      api.onDuplicatesText((json) => setDupes(JSON.parse(json))),
      api.onDuplicatesProgress(progress(setDupesProgress)),
      api.onVideosProgress(progress(setVideosProgress)),
      api.onSmartProgress(progress(setSmartProgress)),
      api.onOcrProgress(progress(setOcrProgress)),
      api.onOcrChanged(() => later(setOcrVersion, () => setOcrVersion((v) => v + 1))),
      api.onHistory(setHistory),
      api.onTags(setTags),
    ]
    api.getStateText().then((s) => {
      pending.clear() // reports that came in before this snapshot are older than it
      setItems(parseItems(s.items))
      setStatus(s.status)
      setSettings(s.settings)
      setVersion(s.version)
      setPeople(JSON.parse(s.people))
      setPeopleProgress(s.peopleProgress)
      setAlbums(s.albums)
      setPlaces(s.places)
      setDupes(JSON.parse(s.dupes))
      setDupesProgress(s.dupesProgress)
      setVideosProgress(s.videosProgress)
      setSmartProgress(s.smartProgress)
      if (s.ocrProgress) setOcrProgress(s.ocrProgress)
      setHistory(s.history)
      setLaunch(s.launch ?? null)
      setTags(s.tags ?? { byItem: {} })
    })
    return () => {
      offs.forEach((off) => off())
      clearTimeout(timer)
    }
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
    ocrProgress,
    ocrVersion,
    history,
    launch,
    tags,
  }
}

/**
 * For each search word, the items whose text (read from the picture) has a word starting with it.
 * Null until the answer for exactly these words is in.
 */
export function useTextHits(tokens: string[], version: number, enabled: boolean) {
  const key = enabled ? tokens.join('\n') : ''
  const [result, setResult] = useState<{ key: string; version: number; hits: Set<string>[] } | null>(null)
  useEffect(() => {
    if (!key) return
    let live = true
    const t = setTimeout(async () => {
      const hits = await api.ocrTokenHits(key.split('\n'))
      if (live) setResult({ key, version, hits: hits.map((ids) => new Set(ids)) })
    }, 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [key, version])
  return key && result?.key === key ? result.hits : null
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
