export type MediaType = 'image' | 'video'

export interface MediaMeta {
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

export type View =
  | { kind: 'photos' }
  | { kind: 'videos' }
  | { kind: 'favorites' }
  | { kind: 'recent' }
  | { kind: 'folders' }
  | { kind: 'folder'; dir: string }
  | { kind: 'people' }
  | { kind: 'person'; id: string }
  | { kind: 'settings' }

export type TypeFilter = 'all' | 'image' | 'video'
