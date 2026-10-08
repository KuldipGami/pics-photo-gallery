import type {
  Album,
  DuplicatesData,
  DuplicatesProgress,
  EditRecipe,
  EraseStep,
  EraseStroke,
  GpuInfo,
  HistoryEntry,
  KeepRule,
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
  OcrProgress,
  VideosProgress,
  WatchAlert,
} from './types'
import type { OrganizePlan } from './components/OrganizeView'
import type { LocationAssignment, LocationSuggestions, PlaceHit, PlaceName } from './components/LocationDialog'
import type { TagsData } from './components/RatingFilter'
import type { ExportBridge } from './components/ExportDialog'
import type { VideoInfo, VideoRecipe } from './components/VideoEditor'
import type { MovieProgress, MovieRequest, MovieResult } from './components/MovieDialog'
import type { PrivateStatus, UnlockResult } from './components/PrivateLock'
import type { ImportPlan, ImportProgress, ImportResult, ImportScan, ImportScanning, ImportSource } from './components/ImportView'

type Unsubscribe = () => void

export interface RemoveResult {
  removed: number
  failed: number
  errors?: string[]
  /** History entry (for undo). */
  entryId?: string | null
  destination?: string
  /** Files that moved but whose XMP sidecar stayed behind ("name: …"); not failures. */
  notes?: string[]
}

/** Everything the window shows, as it opens. */
export interface AppState {
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
  videosProgress: VideosProgress
  smartProgress: SmartProgress
  ocrProgress: OcrProgress
  history: HistoryEntry[]
  /** Pics was started for a folder or to review duplicates (taken once). */
  launch: { folder?: string; duplicates?: boolean } | null
  tags: TagsData
}

/** AppState with items, people and dupes as JSON text. */
export type AppStateText = Omit<AppState, 'items' | 'people' | 'dupes'> & { items: string; people: string; dupes: string }

export interface LumenApi {
  env: { platform: string; mica: boolean }
  getState(): Promise<AppState>
  /** The same, with the big parts as JSON text: what the window itself uses (much quicker, see parseItems). */
  getStateText(): Promise<AppStateText>
  /** Resolves to the new album's id. */
  createAlbum(name: string, ids: string[]): Promise<string>
  /** A saved search that fills itself. Resolves to the new album's id. */
  createSmartAlbum(name: string, query: string): Promise<string | null>
  /** Items that look like this one, most alike first (the item itself first). */
  findSimilar(id: string): Promise<{ ids: string[]; scores: number[] }>
  /** Private: lock state, unlocking, marking items, the hidden folder. */
  privateStatus(): Promise<PrivateStatus>
  privateUnlockHello(): Promise<UnlockResult>
  /** Runs the Windows Hello check again (after it didn't answer); resolves to the new status. */
  privateRecheckHello(): Promise<PrivateStatus>
  privateUnlockPin(pin: string): Promise<UnlockResult>
  privateSetPin(pin: string): Promise<{ ok: boolean; error?: string }>
  privateRemovePin(): Promise<boolean>
  privateLock(): Promise<void>
  /** The private items (empty while locked). */
  privateItems(): Promise<MediaItem[]>
  privateAdd(ids: string[]): Promise<number>
  privateRemove(ids: string[]): Promise<number>
  privateHide(ids: string[]): Promise<{ done: number; errors: string[]; folder: string | null }>
  privateReset(): Promise<boolean>
  onPrivateStatus(cb: (status: PrivateStatus) => void): Unsubscribe
  onPrivateChanged(cb: () => void): Unsubscribe
  exportDefaults: ExportBridge['defaults']
  exportPick: ExportBridge['pick']
  exportStart: ExportBridge['start']
  exportCancel: ExportBridge['cancel']
  exportReveal: ExportBridge['reveal']
  onExportProgress: ExportBridge['onProgress']
  /** Connected phones, cameras and cards. */
  importSources(): Promise<{ sources: ImportSource[]; error: string | null }>
  importPickFolder(): Promise<ImportSource | null>
  importScan(sourceId: string): Promise<ImportScan>
  importPlan(scanId: string, deleteAfter: boolean): Promise<ImportPlan>
  importRun(scanId: string, deleteAfter: boolean): Promise<ImportResult>
  importCancel(): Promise<void>
  importForget(sourceId: string): Promise<number>
  importPickDestination(): Promise<string | null>
  onImportScanProgress(cb: (p: ImportScanning | null) => void): Unsubscribe
  onImportProgress(cb: (p: ImportProgress | null) => void): Unsubscribe
  /** 0–5 stars (0 clears). Resolves to how many changed. */
  rateItems(ids: string[], rating: number): Promise<number>
  editTags(ids: string[], change: { add?: string[]; remove?: string[]; set?: string[] }): Promise<number>
  onTags(cb: (data: TagsData) => void): Unsubscribe
  onTagsError(cb: (text: string) => void): Unsubscribe
  /** Where these were probably taken, from photos taken within `hours` of them. */
  suggestLocations(ids: string[], hours: number): Promise<LocationSuggestions>
  searchPlaces(query: string): Promise<PlaceHit[]>
  describePlace(lat: number, lon: number): Promise<PlaceName | null>
  /** JPEGs get the place in their EXIF (undo from History); other files keep it in Pics. */
  setLocations(assignments: LocationAssignment[], label: string): Promise<{ done: number; kept: { name: string; reason: string }[]; errors: string[] }>
  renameAlbum(id: string, name: string): Promise<void>
  deleteAlbum(id: string): Promise<void>
  /** Resolves to how many were new to the album. */
  addToAlbum(id: string, ids: string[]): Promise<number>
  removeFromAlbum(id: string, ids: string[]): Promise<void>
  setAlbumCover(id: string, itemId: string): Promise<void>
  onAlbums(cb: (albums: Album[]) => void): Unsubscribe
  onPlaces(cb: (places: PlacesData) => void): Unsubscribe
  dismissDuplicates(ids: string[]): Promise<void>
  /** Moves files into one folder (default: the Clean up destination). */
  moveItems(ids: string[], dest?: string): Promise<RemoveResult>
  /** Choose where moved duplicates go (saved as the default). */
  pickDestination(): Promise<string | null>
  pickFolders(title: string): Promise<string[]>
  historyList(): Promise<HistoryEntry[]>
  /**
   * `renamed`: originals of edits put back under a new name ("IMG (2).jpg"), because a different
   * photo has the old name now.
   * `kept`: imported files left in place by an import undo (their originals were removed from the card, or they changed since). */
  restoreHistory(id: string): Promise<{ restored: number; total?: number; kept?: number; renamed?: number }>
  clearHistory(): Promise<void>
  onHistory(cb: (entries: HistoryEntry[]) => void): Unsubscribe
  openRecycleBin(): Promise<void>
  /** Save dialog; writes the HTML or the CSV depending on the chosen type. */
  saveReport(html: string, csv: string): Promise<string | null>
  /** Turns JPEGs by clockwise quarter turns, losslessly (orientation tag only; undo from History). */
  rotateLossless(ids: string[], quarterTurns: number): Promise<{ done: number; errors: string[] }>
  /** Writes the date taken into a JPEG, losslessly (undo from History). */
  setDateTaken(id: string, ms: number): Promise<{ ok?: true; error?: string }>
  /** What Organize would change; `skip` = ids selected for removal in Clean up. */
  organizePlan(skip: string[]): Promise<OrganizePlan>
  /** Choose where dated folders go (saved). */
  pickOrganizeRoot(): Promise<string | null>
  runOrganize(action: 'dates' | 'folders' | 'rename' | 'convert', skip: string[]): Promise<{ done: number; errors: string[] }>
  onOrganizeProgress(cb: (progress: { done: number; total: number } | null) => void): Unsubscribe
  /** Pics moved or renamed files: [old id, new id] pairs. */
  onRelocated(cb: (pairs: [string, string][]) => void): Unsubscribe
  /** Adds/removes "Scan with Pics" in the folder right-click menu. */
  setContextMenu(on: boolean): Promise<{ ok: boolean; error?: string }>
  setStartWithWindows(on: boolean): Promise<{ ok: boolean; error?: string }>
  onWatchAlert(cb: (data: { alert: WatchAlert; log: string[] }) => void): Unsubscribe
  onWatchStatus(cb: (status: { watching: boolean; folders: string[]; text: string }) => void): Unsubscribe
  /** Pics was asked to open a folder (right-click menu, command line). */
  onOpenFolder(cb: (dir: string) => void): Unsubscribe
  onShowDuplicates(cb: () => void): Unsubscribe
  onDuplicates(cb: (data: DuplicatesData) => void): Unsubscribe
  /** The same as JSON text (quicker). */
  onDuplicatesText(cb: (json: string) => void): Unsubscribe
  onDuplicatesProgress(cb: (progress: DuplicatesProgress) => void): Unsubscribe
  onVideosProgress(cb: (progress: VideosProgress) => void): Unsubscribe
  /** Items whose content matches the text, best first, with a 0–1 match score. */
  smartSearch(query: string): Promise<{ ids: string[]; scores: number[] }>
  /** Renders the edit recipe on a smaller copy (JPEG bytes). */
  editPreview(
    id: string,
    recipe: EditRecipe,
    size?: number,
  ): Promise<{ data: Uint8Array; width: number; height: number } | { error: string }>
  /** Saves an edited copy next to the original. */
  editSave(id: string, recipe: EditRecipe): Promise<{ id: string; name: string } | { error: string }>
  editClose(): Promise<void>
  /** Fills the brushed area (strokes in preview coordinates); the step goes into recipe.erase. */
  editErase(id: string, recipe: EditRecipe, strokes: EraseStroke[]): Promise<{ step: EraseStep; ms: number; device: string | null; regions: number } | { error: string }>
  /** Video edits (ffmpeg): facts for the editor, save a trimmed/rotated/muted copy, save a frame. */
  videoInfo(id: string): Promise<VideoInfo | { error: string }>
  videoSave(id: string, recipe: VideoRecipe): Promise<{ id: string; name: string; mode: string } | { error: string } | { canceled: true }>
  videoFrame(id: string, seconds: number): Promise<{ id: string; name: string } | { error: string }>
  videoCancel(): Promise<void>
  onVideoProgress(cb: (fraction: number | null) => void): Unsubscribe
  /** Memory movie: asks where to save it; null = canceled. */
  movieMake(req: MovieRequest): Promise<MovieResult | { error: string } | null>
  movieCancel(): Promise<void>
  moviePickMusic(): Promise<string | null>
  movieOpen(file: string): Promise<void>
  movieReveal(file: string): Promise<void>
  onMovieProgress(cb: (p: MovieProgress | null) => void): Unsubscribe
  /** `warm` starts loading the model. */
  eraserStatus(warm?: boolean): Promise<{ available: boolean; ready: boolean; device: 'gpu' | 'cpu' | null; error?: string }>
  onSmartProgress(cb: (progress: SmartProgress) => void): Unsubscribe
  /** Items whose text (read from the picture) has every word, best first. */
  ocrSearch(query: string): Promise<{ ids: string[]; snippets: string[]; scores: number[] }>
  /** For each (folded) search word: the ids whose text has a word starting with it. */
  ocrTokenHits(tokens: string[]): Promise<string[][]>
  /** The text read in a photo (lines), or null. */
  ocrText(id: string): Promise<string | null>
  onOcrProgress(cb: (progress: OcrProgress) => void): Unsubscribe
  onOcrChanged(cb: () => void): Unsubscribe
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
  /** The same as JSON text (quicker). */
  onPeopleText(cb: (json: string) => void): Unsubscribe
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
      textSearch: boolean
      dupeSensitivity: number
      findCrops: boolean
      keepRule: KeepRule
      protectedFolders: string[]
      moveDestination: string | null
      carryDates: boolean
      blurThreshold: number
      largeFileMB: number
      tagsInFiles: boolean
      xmpSidecars: boolean
      importDestination: null
      importFolderPattern: string
      importSkipKnown: boolean
      importConvertHeic: boolean
      importHeicOriginals: 'aside' | 'next' | 'none'
      organizeRoot: null
      folderPattern: string
      organizeCopy: boolean
      renamePattern: string
      deviceNamesOnly: boolean
      jpegQuality: number
      moveOriginals: boolean
      watchFolders: boolean
      minimizeToTray: boolean
      skippedFolders: string[]
      skippedTypes: string[]
      minFileKB: number
    }>,
  ): Promise<void>
  setFavorite(ids: string[], value: boolean): Promise<void>
  trash(ids: string[]): Promise<RemoveResult>
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
  /** The same with the items as JSON text (quicker, see parseItems). */
  onLibraryText(cb: (payload: { items: string }) => void): Unsubscribe
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

/** The library's items arrive as JSON text: parsing it is several times quicker than receiving ~15,000 objects. */
export const parseItems = (json: string) => JSON.parse(json) as MediaItem[]

const version = (item: MediaItem) => item.mtime.toString(36)
export const thumbUrl = (item: MediaItem, rev = 0) =>
  `gallery://thumb/${item.id}?v=${version(item)}${rev ? `&r=${rev}` : ''}`
export const mediaUrl = (item: MediaItem) => `gallery://media/${item.id}?v=${version(item)}`
export const previewUrl = (item: MediaItem) => `gallery://preview/${item.id}?v=${version(item)}`

/** Formats Chromium can decode natively; everything else is shown via an OS-rendered preview. */
const BROWSER_IMAGES = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico'])
export const fullImageUrl = (item: MediaItem) =>
  BROWSER_IMAGES.has(item.ext) ? mediaUrl(item) : previewUrl(item)
