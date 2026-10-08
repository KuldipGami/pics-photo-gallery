export type MediaType = 'image' | 'video'

export interface MediaMeta {
  /** The place was set in Lumen (the file can't hold one). */
  userLocation?: true
  make?: string
  model?: string
  lens?: string
  f?: number
  exposure?: number
  iso?: number
  focal?: number
  lat?: number
  lon?: number
}

export interface MediaItem {
  /** Stars saved in the file (0 = none); Lumen's own values come in TagsData. */
  rating?: number
  /** Keywords saved in the file. */
  tags?: string[]
  id: string
  path: string
  name: string
  dir: string
  type: MediaType
  ext: string
  size: number
  /** File modified time (ms). Used as the thumbnail cache version. */
  mtime: number
  /** When the file appeared on disk (ms). */
  added: number
  /** Best guess at capture time: EXIF / MP4 metadata, else file time (ms). */
  date: number
  /** Capture date from the file itself (EXIF / video metadata), else null. */
  taken?: number | null
  duration?: number
  meta?: MediaMeta
}

export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
  folders: string[]
  favorites: string[]
  theme: Theme
  accent: string
  thumbSize: number
  highPerformanceGpu: boolean
  faceRecognition: boolean
  smartSearch: boolean
  /** Find photos by the text in them (Windows OCR). */
  textSearch: boolean
  /** Clean up: match threshold 80–99 %. */
  dupeSensitivity: number
  findCrops: boolean
  keepRule: KeepRule
  /** Files in these folders are never selected for removal. */
  protectedFolders: string[]
  /** Where moved duplicates go (null = the default). */
  moveDestination: string | null
  defaultMoveDestination: string
  /** Give kept copies the original's date before removing duplicates. */
  carryDates: boolean
  blurThreshold: number
  largeFileMB: number
  /** Ratings & tags: written into JPEG files (XMP) and, optionally, .xmp sidecars for other files. */
  tagsInFiles: boolean
  xmpSidecars: boolean
  /** Import: null = the first library folder. */
  importDestination: string | null
  importFolderPattern: string
  importSkipKnown: boolean
  importConvertHeic: boolean
  importHeicOriginals: 'aside' | 'next' | 'none'
  /** Organize: where dated folders go (null = the first library folder). */
  organizeRoot: string | null
  folderPattern: string
  organizeCopy: boolean
  renamePattern: string
  deviceNamesOnly: boolean
  jpegQuality: number
  moveOriginals: boolean
  /** "<first library folder>HEIC originals" */
  originalsDir: string
  /** Background: watch library folders for new duplicates. */
  watchFolders: boolean
  minimizeToTray: boolean
  /** Read from Windows, not stored. */
  startWithWindows: boolean
  contextMenu: boolean
  /** Scans skip these folders, file type groups (FileType keys) and files under minFileKB. */
  skippedFolders: string[]
  skippedTypes: string[]
  minFileKB: number
  fileTypes: FileType[]
  watchStatus: string
  watchLog: string[]
}

export interface FileType {
  key: string
  label: string
  extensions: string[]
  video: boolean
}

export interface WatchAlert {
  file: string
  name: string
  match: string
  matchName: string
  matchId?: string
  kind: 'exact' | 'similar'
  text: string
  time: number
  line: string
}

export interface Album {
  id: string
  name: string
  /** Item ids, in the order they were added. */
  items: string[]
  /** Chosen cover item (else the newest photo). */
  cover: string | null
  /** Smart album: a saved search; its photos are whatever matches now (items is empty). */
  query?: string
  created: number
  updated: number
}

export interface Place {
  id: string
  name: string
  /** State / province. */
  admin: string
  country: string
  /** ISO country code. */
  cc: string
  lat: number
  lon: number
  count: number
  /** Newest item taken here. */
  cover: string
}

export interface PlacesData {
  places: Place[]
  /** Item id → place id. */
  byItem: Record<string, string>
}

export type KeepRule = 'best' | 'sharpest' | 'largest' | 'oldest' | 'newest'

/** How a file relates to its group's best copy: ['best'], ['identical'], [''] or [similarity, kind, quarter turns]. */
export type MatchInfo = ['best'] | ['identical'] | [''] | [number, 'same' | 'rotated' | 'mirrored' | 'cropped' | 'trimmed' | 'longer', number]

export interface DupGroup {
  /** Group number (exact groups first, then by path). */
  n: number
  ids: string[]
  exact: boolean
  video: boolean
  /** Index of the best copy (highest quality, ignoring protection). */
  ref: number
  /** Lowest similarity to the best copy (0–1). */
  min: number
  info: MatchInfo[]
  /** Keep order (indexes) for each rule: best, sharpest, largest, oldest, newest. */
  orders: number[][]
  /** Index of the clearly sharpest shot of a burst, or -1. */
  sharpest: number
  /** Video groups: where each clip starts on the longest clip's timeline (s), indexed like ids. */
  offsets?: number[]
}

/** Reading the text in photos (Windows OCR, background). */
export interface OcrProgress {
  done: number
  total: number
  running: boolean
  indexed: number
  withText: number
  available: boolean
  error: string | null
  lang: string | null
}

/** Reading videos' frames for look-alike videos (background). */
export interface VideosProgress {
  running: boolean
  done: number
  total: number
  current: string | null
}

export interface DuplicatesData {
  groups: DupGroup[]
  /** id → [sharpness, brightness, blank (0/1), width, height] for every analysed item. */
  facts: Record<string, [number, number, number, number, number]>
  sensitivity: number
  findCrops: boolean
}

export interface HistoryFile {
  from: string
  to?: string
  size?: number
  restored?: boolean
}

export interface HistoryEntry {
  id: string
  time: number
  kind: 'moved' | 'recycled' | 'copied' | 'renamed' | 'dates' | 'edited' | 'converted' | 'imported'
  destination?: string
  /** Imported: where from. */
  source?: { id: string; name: string; kind: string }
  note?: string
  files: HistoryFile[]
  dateChanges?: { path: string; oldMtime: number; restored?: boolean }[]
}

export interface DuplicatesProgress {
  running: boolean
  phase: 'idle' | 'hashing' | 'comparing'
  done: number
  total: number
}

export interface SmartProgress {
  done: number
  total: number
  running: boolean
  indexed: number
  /** The model files are installed. */
  available: boolean
  error: string | null
  engine: { device: 'gpu' | 'cpu'; adapter: number | null } | null
}

/** Normalised face rectangle [x, y, width, height] (0–1) within the photo. */
export type FaceBox = [number, number, number, number]

export interface Person {
  id: string
  name: string
  hidden: boolean
  /** Number of photos this person appears in. */
  count: number
  /** The chosen (or clearest) face, used as the avatar. `ar` = photo aspect ratio (width / height). */
  cover: { face: string; item: string; box: FaceBox; ar: number }
}

/** [faceId, personId | null, x, y, w, h, distance from the person's average face] */
export type FaceTuple = [string, string | null, number, number, number, number, number]

export interface PeopleData {
  enabled: boolean
  people: Person[]
  /** Photo id → its aspect ratio and every face found in it. */
  byItem: Record<string, { ar: number; faces: FaceTuple[] }>
  analysed: number
  faces: number
}

/** One face, resolved for display. */
export interface FaceRef {
  faceId: string
  personId: string | null
  item: string
  box: FaceBox
  ar: number
  /** How unlike the person's average face this is (higher = more likely a wrong match). */
  dist: number
}

export interface PersonMatch {
  id: string
  distance: number
}

export interface PairSuggestion {
  a: string
  b: string
  distance: number
}

export interface PeopleProgress {
  done: number
  total: number
  running: boolean
  error: string | null
  /** Re-analysing photos after switching to a better face model (names/corrections carry over). */
  upgrading?: boolean
  /** Where the face model runs, once it has started. */
  engine?: { device: 'gpu' | 'cpu'; adapter: number | null } | null
}

export interface GpuInfo {
  name: string
  vendor: string
  gpuCount: number
  hardwareVideoDecode: boolean
  compositing: boolean
  /** What this run was started with (the setting may have changed since). */
  highPerformanceRequested: boolean
}

export interface ScanStatus {
  scanning: boolean
  found: number
}

/** Background thumbnail pre-generation. */
export interface ThumbProgress {
  pending: number
  total: number
}

/** A photo edit (see electron/editor.cjs). Sliders are −1…1. */
export interface EditRecipe {
  /** Clockwise quarter turns. */
  quarter: number
  flip: boolean
  /** Degrees, −45…45. */
  straighten: number
  /** Fractions of the straightened picture. */
  crop: { x: number; y: number; w: number; h: number } | null
  enhance: boolean
  light: number
  contrast: number
  color: number
  warmth: number
}

export interface Trip {
  id: string
  title: string
  /** Where (state / country), for the card's second line. */
  where: string
  start: number
  end: number
  items: string[]
  cover: string
}

export interface Memory {
  /** e.g. "3 years ago" */
  label: string
  year: number
  date: number
  items: string[]
  cover: string
}

export type View =
  | { kind: 'photos' }
  | { kind: 'videos' }
  | { kind: 'favorites' }
  | { kind: 'recent' }
  | { kind: 'folders' }
  | { kind: 'folder'; dir: string }
  | { kind: 'people' }
  | { kind: 'person'; id: string }
  | { kind: 'places' }
  | { kind: 'place'; id: string }
  | { kind: 'albums' }
  | { kind: 'album'; id: string }
  | { kind: 'similar'; id: string }
  | { kind: 'map' }
  | { kind: 'import' }
  | { kind: 'private' }
  | { kind: 'map-items'; ids: string[]; label: string }
  | { kind: 'memories' }
  | { kind: 'trip'; id: string }
  | { kind: 'cleanup' }
  | { kind: 'organize' }
  | { kind: 'history' }
  | { kind: 'settings' }

export type TypeFilter = 'all' | 'image' | 'video'
