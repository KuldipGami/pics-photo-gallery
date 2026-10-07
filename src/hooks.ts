import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { api } from './api'
import type { MediaItem, PeopleData, PeopleProgress, ScanStatus, Settings, ThumbProgress } from './types'

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

/** Live view of the main-process library, settings, scan status and people. */
export function useLibrary() {
  const [items, setItems] = useState<MediaItem[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState<ScanStatus>({ scanning: false, found: 0 })
  const [thumbProgress, setThumbProgress] = useState<ThumbProgress>({ pending: 0, total: 0 })
  const [version, setVersion] = useState('')
  const [people, setPeople] = useState<PeopleData>(EMPTY_PEOPLE)
  const [peopleProgress, setPeopleProgress] = useState<PeopleProgress>({ done: 0, total: 0, running: false, error: null })

  useEffect(() => {
    const offs = [
      api.onPeople(setPeople),
      api.onPeopleProgress(setPeopleProgress),
      api.onLibrary((p) => setItems(p.items)),
      api.onStatus(setStatus),
      api.onThumbProgress(setThumbProgress),
      api.onSettings(setSettings),
    ]
    api.getState().then((s) => {
      setItems(s.items)
      setStatus(s.status)
      setSettings(s.settings)
      setVersion(s.version)
      setPeople(s.people)
      setPeopleProgress(s.peopleProgress)
    })
    return () => offs.forEach((off) => off())
  }, [])

  return { items, settings, setSettings, status, thumbProgress, version, people, peopleProgress }
}

/** Returns a stable function that always calls the latest `fn`. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R) {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}

export function useToasts() {
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([])
  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])
  return { toasts, push }
}
