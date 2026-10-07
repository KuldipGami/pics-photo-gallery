import type {
  Album,
  DuplicatesData,
  DuplicatesProgress,
  GpuInfo,
  MediaItem,
  PairSuggestion,
  PeopleData,
  PeopleProgress,
  PersonMatch,
  PlacesData,
  ScanStatus,
  Settings,
  SmartProgress,
  Theme,
  ThumbProgress,
} from './types'

type Unsubscribe = () => void

export interface LumenApi {
  env: { platform: string; mica: boolean }
  getState(): Promise<{
    items: MediaItem[]
    status: ScanStatus
    settings: Settings
    version: string
    people: PeopleData
    peopleProgress: PeopleProgress
    albums: Album[]
    places: PlacesData
    dupes: DuplicatesData
    dupesProgress: DuplicatesProgress
    smartProgress: SmartProgress
  }>
  /** Resolves to the new album's id. */
  createAlbum(name: string, ids: string[]): Promise<string>
  renameAlbum(id: string, name: string): Promise<void>
  deleteAlbum(id: string): Promise<void>
  /** Resolves to how many were new to the album. */
  addToAlbum(id: string, ids: string[]): Promise<number>
  removeFromAlbum(id: string, ids: string[]): Promise<void>
  setAlbumCover(id: string, itemId: string): Promise<void>
  onAlbums(cb: (albums: Album[]) => void): Unsubscribe
  onPlaces(cb: (places: PlacesData) => void): Unsubscribe
  dismissDuplicates(ids: string[]): Promise<void>
  onDuplicates(cb: (data: DuplicatesData) => void): Unsubscribe
  onDuplicatesProgress(cb: (progress: DuplicatesProgress) => void): Unsubscribe
  /** Items whose content matches the text, best first, with a 0–1 match score. */
  smartSearch(query: string): Promise<{ ids: string[]; scores: number[] }>
  onSmartProgress(cb: (progress: SmartProgress) => void): Unsubscribe
  renamePerson(id: string, name: string): Promise<void>
  hidePerson(id: string, hidden: boolean): Promise<void>
  mergePeople(fromIds: string[], intoId: string): Promise<void>
  rejectFromPerson(id: string, itemIds: string[]): Promise<void>
  resetPeople(): Promise<void>
  /** Move faces into a person (id) or a new person ({ name }). Resolves to the person id. */
  assignFaces(faceIds: string[], target: string | { name: string }): Promise<string | null>
  rejectFaces(faceIds: string[]): Promise<void>
  setPersonCover(id: string, faceId: string): Promise<void>
  removePerson(id: string): Promise<void>
  markNotSame(a: string, b: string): Promise<void>
  hidePeople(ids: string[], hidden: boolean): Promise<void>
  personMatches(id: string): Promise<PersonMatch[]>
  peopleSuggestions(): Promise<PairSuggestion[]>
  onPeople(cb: (data: PeopleData) => void): Unsubscribe
  onPeopleProgress(cb: (progress: PeopleProgress) => void): Unsubscribe
  getGpu(): Promise<GpuInfo>
  relaunch(): Promise<void>
  rescan(): Promise<void>
  addFolders(paths?: string[]): Promise<Settings>
  removeFolder(folder: string): Promise<Settings>
  revealFolder(dir: string): Promise<void>
  setSettings(
    patch: Partial<{
      theme: Theme
      accent: string
      thumbSize: number
      highPerformanceGpu: boolean
      faceRecognition: boolean
      smartSearch: boolean
    }>,
  ): Promise<void>
  setFavorite(ids: string[], value: boolean): Promise<void>
  trash(ids: string[]): Promise<{ removed: number; failed: number }>
  reveal(id: string): Promise<void>
  openExternal(id: string): Promise<string>
  copy(id: string, kind: 'image' | 'path'): Promise<boolean>
  showContextMenu(id: string, ids: string[]): Promise<void>
  startDrag(ids: string[]): void
  reportDuration(id: string, seconds: number): Promise<void>
  cacheInfo(): Promise<{ bytes: number; files: number }>
  clearCache(): Promise<void>
  openUrl(url: string): Promise<void>
  pathForFile(file: File): string
  setViewerMode(open: boolean): Promise<void>
  onLibrary(cb: (payload: { items: MediaItem[] }) => void): Unsubscribe
  onStatus(cb: (status: ScanStatus) => void): Unsubscribe
  onThumbProgress(cb: (progress: ThumbProgress) => void): Unsubscribe
  onSettings(cb: (settings: Settings) => void): Unsubscribe
  onMenuAction(cb: (payload: { action: 'open' | 'delete' | 'album'; id: string; ids: string[] }) => void): Unsubscribe
}

declare global {
  interface Window {
    lumen: LumenApi
  }
}

export const api = window.lumen

const version = (item: MediaItem) => item.mtime.toString(36)
export const thumbUrl = (item: MediaItem, rev = 0) =>
  `gallery://thumb/${item.id}?v=${version(item)}${rev ? `&r=${rev}` : ''}`
export const mediaUrl = (item: MediaItem) => `gallery://media/${item.id}?v=${version(item)}`
export const previewUrl = (item: MediaItem) => `gallery://preview/${item.id}?v=${version(item)}`

/** Formats Chromium can decode natively; everything else is shown via an OS-rendered preview. */
const BROWSER_IMAGES = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico'])
export const fullImageUrl = (item: MediaItem) =>
  BROWSER_IMAGES.has(item.ext) ? mediaUrl(item) : previewUrl(item)
