import type { DupGroup, MediaItem } from '../types'
import { duplicateFolders, largeList, lowQualityList, screenshotList, type Facts } from './cleanup'
import { baseName, formatBytes, formatCount } from './format'

// Insights: what the library contains and where space can be freed (ported from DupeLens'
// MainViewModel.Insights). Pure functions; the view memoizes them.

export type Measure = 'size' | 'count'
export type ReviewTab = 'duplicates' | 'quality' | 'screenshots' | 'large' | 'folders'

const DAY = 86_400_000

// ---------- texts ----------

/** "1 photo" / "1,234 photos" (DupeLens Format.Plural). */
export const plural = (n: number, word: string, many = `${word}s`) => (n === 1 ? `1 ${word}` : `${formatCount(n)} ${many}`)

/** Whole-percent share of a total ("0%" for an empty total). */
export const share = (part: number, total: number) => (total <= 0 ? '0%' : `${Math.round((part * 100) / total)}%`)

// ---------- dates (DupeLens DateTools) ----------

// IMG-20221216-WA0037 / VID-20221216-WA0001 (WhatsApp: date only)
const WHATSAPP = /(?:IMG|VID|AUD|PTT|STK|DOC)-(\d{8})-WA\d+/i
// 20210608_131304, IMG_20220415_132047, Screenshot_20210404-090715, PXL_20230101_101010123
const COMPACT = /(?<!\d)(\d{8})[_-](\d{6})/
// Screenshot_2020-04-23-13-18-24, 2022-12-16 14.30.05
const DASHED = /(?<!\d)(\d{4})-(\d{2})-(\d{2})[ _-](\d{2})[-.](\d{2})[-.](\d{2})/
// Date only: 2022-12-16 or 20221216 surrounded by non-digits
const DATE_ONLY = /(?<!\d)(\d{4})-?(\d{2})-?(\d{2})(?!\d)/

/** Exact parse of yyyyMMdd[HHmmss] as local time; 1990 or later and not in the future (2 days' slack). */
function tryDate(digits: string, now: number): number | null {
  const y = +digits.slice(0, 4)
  const mo = +digits.slice(4, 6)
  const d = +digits.slice(6, 8)
  const h = digits.length >= 14 ? +digits.slice(8, 10) : 0
  const mi = digits.length >= 14 ? +digits.slice(10, 12) : 0
  const s = digits.length >= 14 ? +digits.slice(12, 14) : 0
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
  const date = new Date(y, mo - 1, d, h, mi, s)
  // no 31 February
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  if (y < 1990 || date.getTime() > now + 2 * DAY) return null
  return date.getTime()
}

/** Every pattern above contains one of these; most names without a date fail this single cheap test. */
const ANY_DATE = /\d{4}-?\d{2}-?\d{2}/

/** The date encoded in a file name (ms, local) and whether it includes a time of day. */
export function fileNameDate(fileName: string, now = Date.now()): { date: number; hasTime: boolean } | null {
  const dot = fileName.lastIndexOf('.')
  const name = dot >= 0 ? fileName.slice(0, dot) : fileName
  if (!ANY_DATE.test(name)) return null
  let m = WHATSAPP.exec(name)
  let date = m && tryDate(m[1], now)
  if (date != null) return { date, hasTime: false }
  m = DASHED.exec(name)
  date = m && tryDate(m.slice(1, 7).join(''), now)
  if (date != null) return { date, hasTime: true }
  m = COMPACT.exec(name)
  date = m && tryDate(m[1] + m[2], now)
  if (date != null) return { date, hasTime: true }
  m = DATE_ONLY.exec(name)
  date = m && tryDate(m[1] + m[2] + m[3], now)
  if (date != null) return { date, hasTime: false }
  return null
}

/** Best guess of when a file was taken: EXIF / video date, then the date in its name, then the file date. */
export function bestDate(item: MediaItem, now = Date.now()): number {
  if (item.taken != null && Number.isFinite(item.taken)) return item.taken
  const fromName = fileNameDate(item.name, now)
  if (fromName) {
    if (fromName.hasTime) return fromName.date
    // the name's day with the file's time of day
    const day = new Date(fromName.date)
    const t = new Date(item.mtime)
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.getHours(), t.getMinutes(), t.getSeconds(), t.getMilliseconds()).getTime()
  }
  return item.mtime
}

/** The year of `bestDate` (without working out the time of day). */
export function bestYear(item: MediaItem, now = Date.now()): number {
  if (item.taken != null && Number.isFinite(item.taken)) return new Date(item.taken).getFullYear()
  const fromName = fileNameDate(item.name, now)
  return new Date(fromName ? fromName.date : item.mtime).getFullYear()
}

// ---------- labels ----------

/** File types grouped the way people think of them (DupeLens FileTypes.Groups). */
export const FILE_TYPE_GROUPS: { key: string; label: string; exts: string[]; video: boolean }[] = [
  { key: 'jpeg', label: 'JPEG photos', exts: ['jpg', 'jpeg', 'jpe', 'jfif'], video: false },
  { key: 'heic', label: 'HEIC (iPhone) photos', exts: ['heic', 'heif'], video: false },
  { key: 'png', label: 'PNG images', exts: ['png'], video: false },
  { key: 'gif', label: 'GIF animations', exts: ['gif'], video: false },
  { key: 'webp', label: 'WebP / AVIF', exts: ['webp', 'avif'], video: false },
  { key: 'tiff', label: 'BMP / TIFF', exts: ['bmp', 'tif', 'tiff', 'jxr', 'wdp'], video: false },
  { key: 'raw', label: 'RAW (DNG)', exts: ['dng'], video: false },
  { key: 'mp4', label: 'MP4 / MOV videos', exts: ['mp4', 'mov', 'm4v'], video: true },
  { key: 'mts', label: 'Camcorder videos (MTS)', exts: ['mts', 'm2ts'], video: true },
  { key: 'avi', label: 'AVI / WMV / MKV videos', exts: ['avi', 'wmv', 'mkv'], video: true },
  { key: 'mobile', label: '3GP / WebM / MPEG videos', exts: ['3gp', 'webm', 'mpg', 'mpeg'], video: true },
]
const TYPE_LABELS = new Map(FILE_TYPE_GROUPS.flatMap((g) => g.exts.map((e) => [e, g.label] as const)))

/** "JPEG photos", or the bare extension ("CR2") for types outside the groups. */
export const typeLabel = (ext: string) => TYPE_LABELS.get(ext.toLowerCase()) ?? ext.replace(/^\./, '').toUpperCase()

const clean = (s?: string | null) => {
  const t = (s ?? '').trim()
  return t.endsWith('\0') ? t.replace(/\0+$/, '') : t
}

/** "Samsung SM-G991B", avoiding "Apple Apple iPhone" (DupeLens PhotoMetadata.CameraName). */
export function cameraName(make?: string | null, model?: string | null): string | null {
  const mk = clean(make)
  const md = clean(model)
  if (!md) return mk || null
  if (!mk || md.toLowerCase().startsWith(mk.toLowerCase())) return md
  const shortMake = mk.split(' ')[0]
  return md.toLowerCase().startsWith(shortMake.toLowerCase()) ? md : `${shortMake} ${md}`
}

interface Root {
  /** Lower case, without a trailing separator ("d:" for a drive root). */
  key: string
  name: string
}

const isDriveRoot = (p: string) => /^[a-z]:$/i.test(p) || p === ''

function prepareRoots(roots: string[]): Root[] {
  return roots.map((r) => {
    const trimmed = r.replace(/[\\/]+$/, '')
    return { key: trimmed.toLowerCase(), name: isDriveRoot(trimmed) ? r : baseName(trimmed) }
  })
}

function labelFor(folder: string, roots: Root[]): string {
  const trimmed = folder.replace(/[\\/]+$/, '')
  const lower = trimmed.toLowerCase()
  for (const root of roots) {
    if (lower === root.key) return root.name
    const sep = trimmed.charAt(root.key.length)
    if ((sep === '\\' || sep === '/') && lower.startsWith(root.key)) {
      const rel = trimmed.slice(root.key.length + 1)
      return roots.length > 1 ? `${root.name.replace(/[\\/]+$/, '')}${sep}${rel}` : rel
    }
  }
  return folder
}

/** A folder named relative to the library folder it is in ("2021\\Trip"); prefixed with that folder's name when there are several. */
export const folderLabel = (folder: string, roots: string[]) => labelFor(folder, prepareRoots(roots))

// ---------- bars ----------

/** One labelled total: how many files and how much space. */
export interface Row {
  label: string
  count: number
  bytes: number
}

export interface InsightBar extends Row {
  /** Axis label; empty on crowded timelines so labels never overlap. */
  axis: string
  /** The measured value (bytes or files). */
  value: number
  valueText: string
  /** Share of the track (0–scale), relative to the largest bar. */
  fraction: number
  /** "label\nN files · size" */
  tooltip: string
  /** The first bar with the largest value. */
  isPeak: boolean
}

export interface BarOptions {
  /** Keep at most this many bars, folding the rest into one `other` bar. */
  top?: number
  other?: string
  /** Keep the given order (timelines) instead of largest first; no folding. */
  keepOrder?: boolean
  /** Largest bar's share of the track, leaving room for its value label. */
  scale?: number
}

export const measureOf = (r: Row, measure: Measure) => (measure === 'size' ? r.bytes : r.count)

/**
 * Turns rows into bars measured by space or by number of files. Long tails fold into one "Other" bar.
 * Bars use at most 80% of the track so the value fits at the bar's tip.
 */
export function buildBars(source: Row[], measure: Measure, opts: BarOptions = {}): InsightBar[] {
  const { top = Infinity, other = 'Other', keepOrder = false, scale = 0.8 } = opts
  let rows = source
  if (!keepOrder) {
    rows = [...source].sort((a, b) => measureOf(b, measure) - measureOf(a, measure))
    if (rows.length > top) {
      const keep = Math.max(0, top - 1)
      const tail = rows.slice(keep)
      rows = [...rows.slice(0, keep), { label: other, count: tail.reduce((s, t) => s + t.count, 0), bytes: tail.reduce((s, t) => s + t.bytes, 0) }]
    }
  }
  let max = 0
  for (const r of rows) max = Math.max(max, measureOf(r, measure))
  if (max <= 0) max = 1
  let peakSet = false
  return rows.map((r) => {
    const value = measureOf(r, measure)
    const isPeak = !peakSet && value >= max
    peakSet ||= isPeak
    return {
      label: r.label,
      count: r.count,
      bytes: r.bytes,
      axis: r.label,
      value,
      valueText: measure === 'size' ? formatBytes(r.bytes) : formatCount(r.count),
      fraction: (value / max) * scale,
      tooltip: `${r.label}\n${plural(r.count, 'file')} · ${formatBytes(r.bytes)}`,
      isPeak,
    }
  })
}

// ---------- the library ----------

export interface LibraryStats {
  files: number
  bytes: number
  photos: number
  photoBytes: number
  videos: number
  videoBytes: number
  /** Every year from the first to the last (empty years included), oldest first. */
  years: Row[]
  /** Years that have at least one file. */
  yearsWithFiles: number
  firstYear: number | null
  lastYear: number | null
  types: Row[]
  /** Photos only, by camera or phone (case-insensitive). */
  cameras: Row[]
  /** Photos that don't name a camera. */
  noCamera: number
  /** Files directly inside each folder, labelled relative to their library folder. */
  folders: Row[]
}

function add(map: Map<string, Row>, key: string, label: () => string, size: number) {
  let row = map.get(key)
  if (!row) map.set(key, (row = { label: label(), count: 0, bytes: 0 }))
  row.count++
  row.bytes += size
}

/** Everything the charts need that doesn't depend on the measure (one pass over the items). */
export function libraryStats(items: MediaItem[], roots: string[], now = Date.now()): LibraryStats {
  const prepared = prepareRoots(roots)
  let photos = 0
  let photoBytes = 0
  let videos = 0
  let videoBytes = 0
  const byYear = new Map<number, Row>()
  const types = new Map<string, Row>()
  const cameras = new Map<string, Row>()
  const folders = new Map<string, Row>()
  const typeOf = new Map<string, string>()
  for (const it of items) {
    const size = it.size || 0
    if (it.type === 'video') {
      videos++
      videoBytes += size
    } else {
      photos++
      photoBytes += size
      const camera = cameraName(it.meta?.make, it.meta?.model)
      if (camera) add(cameras, camera.toLowerCase(), () => camera, size)
    }
    const year = bestYear(it, now)
    if (Number.isFinite(year)) {
      let row = byYear.get(year)
      if (!row) byYear.set(year, (row = { label: String(year), count: 0, bytes: 0 }))
      row.count++
      row.bytes += size
    }
    const type = typeOf.get(it.ext) ?? typeOf.set(it.ext, typeLabel(it.ext)).get(it.ext)!
    add(types, type, () => type, size)
    add(folders, it.dir.toLowerCase(), () => labelFor(it.dir, prepared), size)
  }

  const yearKeys = [...byYear.keys()].sort((a, b) => a - b)
  const years: Row[] = []
  if (yearKeys.length) {
    // fill missing years so gaps show as empty slots on the timeline
    for (let y = yearKeys[0]; y <= yearKeys[yearKeys.length - 1]; y++) years.push(byYear.get(y) ?? { label: String(y), count: 0, bytes: 0 })
  }
  const cameraRows = [...cameras.values()]
  return {
    files: items.length,
    bytes: photoBytes + videoBytes,
    photos,
    photoBytes,
    videos,
    videoBytes,
    years,
    yearsWithFiles: yearKeys.length,
    firstYear: yearKeys.length ? yearKeys[0] : null,
    lastYear: yearKeys.length ? yearKeys[yearKeys.length - 1] : null,
    types: [...types.values()],
    cameras: cameraRows,
    noCamera: photos - cameraRows.reduce((s, r) => s + r.count, 0),
    folders: [...folders.values()],
  }
}

// ---------- where you can free space ----------

export interface SpaceRow {
  /** The Clean up list that shows these files. */
  tab: ReviewTab
  title: string
  detail: string
  sizeText: string
  bytes: number
}

export interface SpaceStats {
  rows: SpaceRow[]
  /** Space taken by every copy except the best of each duplicate group. */
  extraBytes: number
  extraCount: number
  groupCount: number
}

export interface SpaceInput {
  items: MediaItem[]
  groups: DupGroup[]
  facts: Facts
  blurThreshold: number
  largeFileMB: number
  byId?: Map<string, MediaItem>
}

const sum = (list: { item: MediaItem }[]) => list.reduce((s, l) => s + l.item.size, 0)

export function spaceStats({ items, groups, facts, blurThreshold, largeFileMB, byId }: SpaceInput): SpaceStats {
  const ids = byId ?? new Map(items.map((it) => [it.id, it]))
  // groups whose files still exist (as in Clean up)
  const live = groups.filter((g) => g.ids.reduce((n, id) => (ids.has(id) ? n + 1 : n), 0) > 1)
  let extraBytes = 0
  let extraCount = 0
  for (const g of live) {
    const present = g.ids.map((id, i) => ({ it: ids.get(id), i })).filter((x): x is { it: MediaItem; i: number } => !!x.it)
    // keep the best copy; should it be gone, the largest one left
    const keep = present.some((x) => x.i === g.ref) ? g.ref : present.reduce((a, b) => (b.it.size > a.it.size ? b : a)).i
    for (const x of present) if (x.i !== keep) extraBytes += x.it.size
    extraCount += present.length - 1
  }

  const rows: SpaceRow[] = []
  if (extraCount > 0)
    rows.push({
      tab: 'duplicates',
      title: 'Extra copies of duplicates',
      detail: `${plural(extraCount, 'copy', 'copies')} in ${plural(live.length, 'group')}, keeping the best of each`,
      sizeText: formatBytes(extraBytes),
      bytes: extraBytes,
    })
  const quality = lowQualityList(items, facts, blurThreshold)
  if (quality.length) {
    const bytes = sum(quality)
    rows.push({ tab: 'quality', title: 'Blurry and dark photos', detail: plural(quality.length, 'photo'), sizeText: formatBytes(bytes), bytes })
  }
  const shots = screenshotList(items)
  if (shots.length) {
    const bytes = sum(shots)
    rows.push({ tab: 'screenshots', title: 'Screenshots and screen recordings', detail: plural(shots.length, 'file'), sizeText: formatBytes(bytes), bytes })
  }
  const pairs = duplicateFolders(items, live, ids)
  if (pairs.length) {
    const bytes = pairs.reduce((s, p) => s + Math.min(p.bytesA, p.bytesB), 0)
    rows.push({ tab: 'folders', title: 'Folders copied into other folders', detail: plural(pairs.length, 'folder pair'), sizeText: formatBytes(bytes), bytes })
  }
  const large = largeList(items, largeFileMB * 1024 * 1024)
  if (large.length) {
    const bytes = sum(large)
    rows.push({
      tab: 'large',
      title: `Files over ${formatCount(largeFileMB)} MB`,
      detail: `${plural(large.length, 'file')}, worth a look if space is tight`,
      sizeText: formatBytes(bytes),
      bytes,
    })
  }
  return { rows, extraBytes, extraCount, groupCount: live.length }
}

// ---------- headline tiles ----------

export interface Tile {
  label: string
  value: string
  detail: string
}

export function headlineTiles(lib: LibraryStats, space: SpaceStats): Tile[] {
  const { firstYear, lastYear, yearsWithFiles } = lib
  return [
    { label: 'Photos', value: formatCount(lib.photos), detail: `${formatBytes(lib.photoBytes)} · ${share(lib.photoBytes, lib.bytes)} of the space` },
    { label: 'Videos', value: formatCount(lib.videos), detail: `${formatBytes(lib.videoBytes)} · ${share(lib.videoBytes, lib.bytes)} of the space` },
    {
      label: 'Years covered',
      value: firstYear == null || lastYear == null ? '—' : firstYear === lastYear ? `${firstYear}` : `${firstYear} – ${lastYear}`,
      detail: yearsWithFiles ? `${plural(yearsWithFiles, 'year')} with photos` : '',
    },
    {
      label: 'Duplicates waste',
      value: formatBytes(space.extraBytes),
      detail: space.extraCount === 0 ? 'No duplicates found' : `by removing ${plural(space.extraCount, 'extra copy', 'extra copies')}`,
    },
  ]
}

// ---------- charts ----------

/** At most this many year labels under the timeline. */
export const MAX_AXIS_LABELS = 14

export interface InsightCharts {
  years: InsightBar[]
  /** "Busiest year: 2019 (4.2 GB)" */
  yearPeakText: string
  types: InsightBar[]
  cameras: InsightBar[]
  /** Which photos don't name a camera (empty without photos). */
  cameraNote: string
  folders: InsightBar[]
}

export function cameraNote(lib: LibraryStats) {
  if (lib.photos === 0) return ''
  if (lib.noCamera === 0) return 'Every photo names the camera or phone that took it.'
  return `${plural(lib.noCamera, 'photo')} (${share(lib.noCamera, lib.photos)}) don't say which camera took them: usually WhatsApp copies, screenshots and downloads.`
}

export function insightCharts(lib: LibraryStats, measure: Measure): InsightCharts {
  const yearBars = buildBars(lib.years, measure, { keepOrder: true, scale: 0.85 })
  const every = Math.ceil(yearBars.length / MAX_AXIS_LABELS)
  const years = every <= 1 ? yearBars : yearBars.map((b, i) => (i % every === 0 ? b : { ...b, axis: '' }))
  const peak = years.find((b) => b.isPeak)
  return {
    years,
    yearPeakText: peak ? `Busiest year: ${peak.label} (${peak.valueText})` : '',
    types: buildBars(lib.types, measure, { top: 8, other: 'Other types' }),
    cameras: buildBars(lib.cameras, measure, { top: 8, other: 'Other cameras' }),
    cameraNote: cameraNote(lib),
    folders: buildBars(lib.folders, measure, { top: 10, other: 'Other folders' }),
  }
}

export interface InsightsInput extends SpaceInput {
  roots: string[]
}

/** Everything at once (the view memoizes the parts separately so switching the measure is instant). */
export function computeInsights(input: InsightsInput, measure: Measure) {
  const lib = libraryStats(input.items, input.roots)
  const space = spaceStats(input)
  return { lib, space, tiles: headlineTiles(lib, space), charts: insightCharts(lib, measure) }
}
