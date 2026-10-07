import type { MediaItem } from '../types'

const DAY = 86_400_000
const startOfDay = (ts: number) => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const dayYearFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const shortMonthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' })
const longDateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthNameFmt = new Intl.DateTimeFormat(undefined, { month: 'long' })

export function formatDayHeader(ts: number) {
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return new Date(ts).getFullYear() === new Date().getFullYear() ? dayFmt.format(ts) : dayYearFmt.format(ts)
}

export const formatMonthHeader = (ts: number) => monthFmt.format(ts)
export const formatShortMonth = (ts: number) => shortMonthFmt.format(ts)
export const formatLongDate = (ts: number) => longDateFmt.format(ts)
export const formatTime = (ts: number) => timeFmt.format(ts)
export const formatCount = (n: number) => n.toLocaleString()

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return ''
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function formatExposure(sec: number) {
  if (sec >= 1) return `${+sec.toFixed(1)}s`
  return `1/${Math.round(1 / sec)}`
}

export function formatRange(items: MediaItem[], field: 'date' | 'added' = 'date') {
  if (!items.length) return ''
  let min = Infinity
  let max = -Infinity
  for (const it of items) {
    if (it[field] < min) min = it[field]
    if (it[field] > max) max = it[field]
  }
  const a = formatShortMonth(min)
  const b = formatShortMonth(max)
  return a === b ? a : `${a} – ${b}`
}

export function summarize(items: MediaItem[]) {
  let videos = 0
  for (const it of items) if (it.type === 'video') videos++
  const photos = items.length - videos
  const parts = []
  if (photos) parts.push(`${formatCount(photos)} photo${photos === 1 ? '' : 's'}`)
  if (videos) parts.push(`${formatCount(videos)} video${videos === 1 ? '' : 's'}`)
  return parts.join(' · ') || 'No items'
}

export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p

// ---------- search ----------

const searchCache = new WeakMap<MediaItem, string>()

function searchText(item: MediaItem) {
  let text = searchCache.get(item)
  if (text === undefined) {
    const d = new Date(item.date)
    text = [
      item.name,
      baseName(item.dir),
      monthNameFmt.format(d),
      d.getFullYear(),
      item.meta?.make,
      item.meta?.model,
      item.type === 'video' ? 'video' : 'photo',
      item.ext,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    searchCache.set(item, text)
  }
  return text
}

export const searchTokens = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)
export const matchesSearch = (item: MediaItem, tokens: string[]) => {
  const text = searchText(item)
  return tokens.every((t) => text.includes(t))
}
