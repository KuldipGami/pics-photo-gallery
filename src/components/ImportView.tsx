import {
  ArrowLeft,
  CardSim,
  CircleAlert,
  CircleCheck,
  FileImage,
  Film,
  FolderOpen,
  FolderSearch,
  FolderTree,
  HardDrive,
  ImageOff,
  Import,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  TriangleAlert,
  Undo2,
  Usb,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { formatBytes, formatCount } from '../lib/format'
import { FOLDER_PATTERNS } from './OrganizeView'
import './import.css'

/**
 * Import from a phone, camera, memory card or folder: pick a source, see what's new, choose where
 * it goes, import. Props-driven: everything comes from the main process (electron/importer.cjs)
 * and every action is a callback, so this component never talks to IPC itself.
 */

// ---------- data (shapes produced by electron/importer.cjs) ----------

export type ImportSourceKind = 'device' | 'drive' | 'folder'

/** A place to import from (importer.listSources / folderSource). */
export interface ImportSource {
  id: string
  kind: ImportSourceKind
  /** "Apple iPhone", "EOS_DIGITAL (E:)", "Camera uploads" */
  name: string
  /** "iPhone or iPad", "Memory card or camera", "USB drive", or a folder's path */
  detail: string
  path: string
  removable: boolean
  /** Has a DCIM (camera) folder; phones: assumed until looked through. */
  hasDcim: boolean
  /** Originals can be removed after importing (cards and folders; never phones). */
  canDelete: boolean
  /** Files remembered from earlier imports from this source, and when the last one was. */
  remembered: number
  lastImport: number | null
  size?: number
  free?: number
}

/**
 * new: not in the library · library: same content as a library file · imported: imported from this
 * source before but not in the library now (deleted since) · twin: same as another file on the source.
 */
export type ImportStatus = 'new' | 'library' | 'imported' | 'twin'

export interface ImportCandidate {
  id: string
  name: string
  /** Path inside the source ("DCIM\\100CANON\\IMG_0001.JPG"). */
  rel: string
  size: number
  /** Best known date: taken, else from the name, else the file date (ms). */
  date: number
  type: 'image' | 'video'
  ext: string
  status: ImportStatus
  /** The library file it matches (status 'library'). */
  match?: string
  /** Matched by name/date + size only (phones), not by content. */
  likely?: boolean
}

/** What looking through a source found (importer.scan). */
export interface ImportScan {
  scanId: string
  source: ImportSource
  /** Newest first. */
  items: ImportCandidate[]
  counts: {
    total: number
    new: number
    newBytes: number
    library: number
    imported: number
    importedBytes: number
    twins: number
    /** Other files (sidecars like .THM/.AAE, documents, skipped types). */
    skipped: number
    /** HEIC photos and videos among the new + imported-before ones. */
    heic: number
    videos: number
  }
  skippedTypes: { ext: string; count: number }[]
  /** Dates of the new + imported-before files. */
  range: { first: number; last: number } | null
  /** Previews can be shown (cards and folders; phones only after copying). */
  thumbs: boolean
  roots: string[]
  errors: string[]
}

/** How the import would go with the current options (importer.plan). */
export interface ImportPlan {
  count: number
  bytes: number
  heic: number
  folders: number
  /** First few dated folders (relative to the destination) and how many files go in each. */
  preview: { folder: string; count: number }[]
}

/** The choices, saved by the app (except deleteAfter, which starts off every time). */
export interface ImportOptions {
  /** Where the dated folders go; null = the first library folder. */
  destination: string | null
  folderPattern: string
  /** Leave out files imported from this source before, even if they were deleted since. */
  skipImported: boolean
  convertHeic: boolean
  /** After converting: keep the HEIC in "HEIC originals", next to the JPG, or not at all. */
  heicOriginals: 'aside' | 'next' | 'none'
  /** Remove the originals from the card once each copy is verified (cards and folders only). */
  deleteAfter: boolean
}

export const IMPORT_DEFAULTS: ImportOptions = {
  destination: null,
  folderPattern: 'yyyy\\\\MM - MMMM',
  skipImported: true,
  convertHeic: false,
  heicOriginals: 'aside',
  deleteAfter: false,
}

export interface ImportProgress {
  phase: 'copying' | 'converting' | 'removing'
  done: number
  total: number
  bytes: number
  totalBytes: number
  /** The file being worked on. */
  name?: string
}

/** Looking through a source. */
export interface ImportScanning {
  source: ImportSource
  phase: 'listing' | 'checking'
  done: number
  total: number
}

/** How an import went (importer.run, without its file list). */
export interface ImportResult {
  imported: number
  bytes: number
  converted: number
  removed: number
  /** Found to be in the library (or repeats) only while copying from a phone. */
  alreadyHad: number
  errors: string[]
  warnings: string[]
  cancelled: boolean
  destination: string
  /** History entry (kind 'imported'), for Undo. */
  entryId: string | null
}

export interface ImportViewProps {
  /** Connected phones, cameras and cards; null while looking for them. */
  sources: ImportSource[] | null
  /** Couldn't look for devices (shown above the list). */
  sourcesError?: string | null
  scanning: ImportScanning | null
  scan: ImportScan | null
  plan: ImportPlan | null
  options: ImportOptions
  /** The destination shown when options.destination is null (the first library folder). */
  defaultDestination: string
  /** The destination isn't inside a library folder (Pics would add it). */
  destinationOutside?: boolean
  /** Where HEIC originals go for 'aside'. */
  originalsDir?: string
  progress: ImportProgress | null
  /** Import was clicked and the copying hasn't reported yet: the button stays off (no second run). */
  starting?: boolean
  result: ImportResult | null
  /** Preview URL for a candidate, or null (phones). */
  thumb(item: ImportCandidate): string | null
  onRefresh(): void
  onPickFolder(): void
  onScan(source: ImportSource): void
  onCancelScan(): void
  /** Back to the list of sources. */
  onBack(): void
  onImport(): void
  onCancel(): void
  onOptions(patch: Partial<ImportOptions>): void
  onChangeDestination(): void
  /** Forget what was imported from this source before. */
  onForget(source: ImportSource): void
  onOpenFolder(dir: string): void
  onUndo?(entryId: string): void
}

// ---------- helpers (also for the app's confirm dialog and toasts) ----------

const plural = (n: number, word: string, many = word + 's') => `${formatCount(n)} ${n === 1 ? word : many}`
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** One line about when files are from: "12 Mar 2024 – 3 Oct 2026". */
export function rangeText(range: ImportScan['range']) {
  if (!range) return ''
  const a = dayFmt.format(range.first)
  const b = dayFmt.format(range.last)
  return a === b ? a : `${a} – ${b}`
}

/** "Last imported 3 Oct 2026 · 1,234 files remembered" (empty when never imported). */
export function memoryText(source: ImportSource) {
  if (!source.remembered) return ''
  return `${source.lastImport ? `Last imported ${dayFmt.format(source.lastImport)} · ` : ''}${plural(source.remembered, 'file')} remembered`
}

/** Confirmation, only needed when originals will be removed from the source. */
export function importConfirm(scan: ImportScan, plan: ImportPlan, options: ImportOptions): { title: string; message: string; confirmLabel: string } | null {
  if (!options.deleteAfter || !scan.source.canDelete || !plan.count) return null
  const keepsHeic = !(options.convertHeic && options.heicOriginals === 'none')
  return {
    title: `Import ${plural(plan.count, 'file')} and remove them from ${scan.source.name}?`,
    message:
      `Each file is removed from ${scan.source.name} only after its copy has been checked byte for byte. ` +
      (scan.source.kind === 'folder' ? 'Removed files go to the Recycle Bin.' : "Files removed from a memory card can't be brought back from the Recycle Bin.") +
      (keepsHeic ? '' : ' HEIC photos stay on it, because only their JPG copies are kept.'),
    confirmLabel: 'Import and remove',
  }
}

/** Result toast. */
export function importDoneText(r: ImportResult): { text: string; error: boolean } {
  const failed = r.errors.length
  if (r.cancelled) return { text: `Import stopped. ${plural(r.imported, 'file')} imported before that.`, error: false }
  if (!r.imported && !failed) return { text: r.alreadyHad ? 'Everything was already in your library.' : 'Nothing new to import.', error: false }
  const parts = [`Imported ${plural(r.imported, 'file')}`]
  if (r.converted) parts.push(`converted ${plural(r.converted, 'HEIC photo')} to JPG`)
  if (r.removed) parts.push(`removed ${formatCount(r.removed)} from the source`)
  let text = parts.join(', ') + '.'
  if (failed) text += ` ${plural(failed, 'problem')}: ${r.errors[0]}`
  return { text, error: failed > 0 }
}

const PHASE: Record<ImportProgress['phase'], string> = {
  copying: 'Copying',
  converting: 'Converting HEIC to JPG',
  removing: 'Removing originals',
}

/** "About 3 minutes left" from progress so far (null until there is enough to go on). */
function eta(started: number, fraction: number) {
  const spent = Date.now() - started
  if (fraction <= 0.02 || spent < 3000) return null
  const left = (spent / fraction - spent) / 1000
  if (left < 50) return 'Less than a minute left'
  const min = Math.round(left / 60)
  return min < 60 ? `About ${plural(min, 'minute')} left` : `About ${plural(Math.round(min / 60), 'hour')} left`
}

function SourceIcon({ source, size = 22 }: { source: ImportSource; size?: number }) {
  if (source.kind === 'device') return <Smartphone size={size} />
  if (source.kind === 'folder') return <FolderOpen size={size} />
  if (!source.hasDcim) return <Usb size={size} />
  return source.removable ? <CardSim size={size} /> : <HardDrive size={size} />
}

// ---------- view ----------

type Tab = 'new' | 'imported' | 'library' | 'twin'
const GRID_LIMIT = 240

export function ImportView(props: ImportViewProps) {
  if (props.result) return <Shell>{<Done {...props} result={props.result} />}</Shell>
  if (props.progress) return <Shell>{<Importing {...props} progress={props.progress} />}</Shell>
  if (props.scanning) return <Shell>{<Scanning {...props} scanning={props.scanning} />}</Shell>
  if (props.scan) return <Shell>{<Results {...props} scan={props.scan} />}</Shell>
  return <Shell>{<Sources {...props} />}</Shell>
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="imp-scroll">
      <div className="imp">{children}</div>
    </div>
  )
}

// ----- 1. sources -----

function Sources(props: ImportViewProps) {
  const { sources } = props
  const looking = sources === null
  return (
    <>
      <section className="card imp-intro">
        <span className="imp-hero">
          <Import size={22} />
        </span>
        <div className="imp-intro-text">
          <h2>Import photos and videos</h2>
          <p>Connect a phone or camera, or insert a memory card. Pics copies only what isn't in your library yet, into folders by date.</p>
        </div>
        <button className="btn ghost" onClick={props.onRefresh} disabled={looking} title="Look for phones and cards again">
          {looking ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} {looking ? 'Looking…' : 'Refresh'}
        </button>
      </section>

      {props.sourcesError && (
        <div className="imp-banner warn">
          <TriangleAlert size={16} /> {props.sourcesError}
        </div>
      )}

      <div className="imp-sources">
        {(sources ?? []).map((s) => (
          <button key={s.id} className="imp-source" onClick={() => props.onScan(s)}>
            <span className={`imp-source-icon ${s.kind}`}>
              <SourceIcon source={s} />
            </span>
            <span className="imp-source-text">
              <span className="imp-source-name" title={s.name}>
                {s.name}
              </span>
              <span className="imp-source-detail" title={s.detail}>
                {s.detail}
              </span>
              {s.remembered > 0 && <span className="imp-source-memory">{memoryText(s)}</span>}
            </span>
            <span className="imp-source-go">Look for new photos</span>
          </button>
        ))}
        <button className="imp-source folder" onClick={props.onPickFolder}>
          <span className="imp-source-icon folder">
            <FolderSearch size={22} />
          </span>
          <span className="imp-source-text">
            <span className="imp-source-name">Choose a folder…</span>
            <span className="imp-source-detail">Import from any folder, like a camera backup or a download</span>
          </span>
        </button>
      </div>

      {!looking && !(sources ?? []).length && (
        <div className="imp-hints">
          <h3>Don't see your phone?</h3>
          <ul>
            <li>
              <b>iPhone:</b> unlock it and tap <i>Trust</i> when asked. Photos only show while it's unlocked.
            </li>
            <li>
              <b>Android:</b> in the USB notification, choose <i>File transfer</i> (or <i>Transfer photos</i>).
            </li>
            <li>
              <b>Memory card or camera:</b> it shows up here once Windows gives it a drive letter.
            </li>
          </ul>
        </div>
      )}
    </>
  )
}

// ----- 2. looking through a source -----

function Scanning(props: ImportViewProps & { scanning: ImportScanning }) {
  const { scanning } = props
  const text =
    scanning.phase === 'listing'
      ? `Looking through ${scanning.source.name}… ${scanning.done ? `${plural(scanning.done, 'file')} found` : ''}`
      : `Checking what's new… ${formatCount(scanning.done)} of ${formatCount(scanning.total)}`
  const pct = scanning.phase === 'checking' && scanning.total ? (scanning.done / scanning.total) * 100 : null
  return (
    <section className="card imp-busy">
      <span className={`imp-source-icon ${scanning.source.kind}`}>
        <SourceIcon source={scanning.source} />
      </span>
      <div className="imp-busy-body">
        <h2>{scanning.source.name}</h2>
        <p className="imp-busy-line">
          <LoaderCircle size={15} className="spin" /> {text}
        </p>
        <Bar pct={pct} />
        {scanning.source.kind === 'device' && <p className="imp-note">Phones are slow to list their files: this can take a minute for a few thousand photos.</p>}
      </div>
      <button className="btn" onClick={props.onCancelScan}>
        Cancel
      </button>
    </section>
  )
}

// ----- 3. what's new -----

function Results(props: ImportViewProps & { scan: ImportScan }) {
  const { scan, options, plan } = props
  const { counts, source } = scan
  const [tab, setTab] = useState<Tab>('new')
  useEffect(() => setTab('new'), [scan.scanId])
  const destination = options.destination || props.defaultDestination
  const count = plan?.count ?? counts.new + (options.skipImported ? 0 : counts.imported)
  const bytes = plan?.bytes ?? counts.newBytes + (options.skipImported ? 0 : counts.importedBytes)
  const heic = plan?.heic ?? counts.heic
  const like = FOLDER_PATTERNS.find((p) => p.value === options.folderPattern)?.label ?? ''
  const shown = scan.items.filter((i) => i.status === tab || (tab === 'new' && i.status === 'imported' && !options.skipImported))
  const canDelete = source.canDelete

  const tabs: { key: Tab; label: string; n: number }[] = [
    { key: 'new', label: options.skipImported ? 'New' : 'To import', n: count },
    { key: 'imported', label: 'Imported before', n: counts.imported },
    { key: 'library', label: 'Already in your library', n: counts.library },
    { key: 'twin', label: 'Repeats', n: counts.twins },
  ]

  return (
    <>
      <div className="imp-head">
        <button className="icon-btn" onClick={props.onBack} disabled={props.starting} title="Back to devices">
          <ArrowLeft size={18} />
        </button>
        <span className={`imp-source-icon small ${source.kind}`}>
          <SourceIcon source={source} size={17} />
        </span>
        <div className="imp-head-text">
          <h2 title={source.path}>{source.name}</h2>
          <p>
            {plural(counts.total, 'photo or video', 'photos and videos')}
            {scan.range ? ` · new ones from ${rangeText(scan.range)}` : ''}
          </p>
        </div>
        <button className="btn ghost" onClick={() => props.onScan(source)} disabled={props.starting} title="Look through it again">
          <RefreshCw size={15} /> Look again
        </button>
      </div>

      {scan.errors.map((e) => (
        <div className="imp-banner warn" key={e}>
          <TriangleAlert size={16} /> {e}
        </div>
      ))}

      <div className="imp-stats">
        <Stat tone="accent" value={formatCount(counts.new)} label={counts.new === 1 ? 'new file' : 'new files'} sub={counts.new ? formatBytes(counts.newBytes) : undefined} />
        <Stat value={formatCount(counts.library)} label="already in your library" />
        {counts.imported > 0 && <Stat tone="amber" value={formatCount(counts.imported)} label="imported before" sub="not in your library now" />}
        {counts.twins > 0 && <Stat value={formatCount(counts.twins)} label={counts.twins === 1 ? 'repeat on the device' : 'repeats on the device'} />}
        {counts.skipped > 0 && (
          <Stat
            value={formatCount(counts.skipped)}
            label={counts.skipped === 1 ? 'other file skipped' : 'other files skipped'}
            sub={scan.skippedTypes
              .slice(0, 4)
              .map((t) => t.ext)
              .join(' ')}
            title={scan.skippedTypes.map((t) => `${t.ext}: ${formatCount(t.count)}`).join('\n')}
          />
        )}
      </div>

      <section className="card imp-options">
        <div className="imp-form">
          <span className="imp-label">Into</span>
          <div className="imp-root">
            <FolderOpen size={15} />
            <span className="imp-root-path" title={destination}>
              {destination || 'No folder chosen'}
            </span>
            <button className="link" onClick={props.onChangeDestination}>
              Change…
            </button>
          </div>
          {props.destinationOutside && (
            <>
              <span />
              <p className="imp-warn">
                <CircleAlert size={14} /> This folder isn't in your library yet. It will be added, so the imported photos show up.
              </p>
            </>
          )}
          <span className="imp-label">Folders</span>
          <div className="imp-inline">
            <select className="imp-select" value={options.folderPattern} onChange={(e) => props.onOptions({ folderPattern: e.target.value })}>
              {FOLDER_PATTERNS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            {plan && plan.folders > 0 && (
              <span className="imp-hint" title={plan.preview.map((p) => `${p.folder}: ${plural(p.count, 'file')}`).join('\n')}>
                <FolderTree size={13} /> {plural(plan.folders, 'folder')}
                {plan.preview[0] ? `, like "${plan.preview[0].folder}"` : like ? `, like "${like}"` : ''}
              </span>
            )}
          </div>

          <span className="imp-label">Options</span>
          <div className="imp-switches">
            <Switch
              on={options.skipImported}
              onChange={(v) => props.onOptions({ skipImported: v })}
              label="Skip files imported before"
              hint={
                counts.imported > 0
                  ? `${plural(counts.imported, 'file')} came from ${source.name} before and ${counts.imported === 1 ? "isn't" : "aren't"} in your library now (probably deleted).`
                  : source.remembered > 0
                    ? `Pics remembers ${plural(source.remembered, 'file')} from ${source.name}, so photos you delete don't come back.`
                    : "Pics remembers what it imports from each device, so photos you delete don't come back next time."
              }
              extra={
                source.remembered > 0 ? (
                  <button className="link" onClick={() => props.onForget(source)}>
                    Forget
                  </button>
                ) : null
              }
            />
            {heic > 0 && (
              <Switch
                on={options.convertHeic}
                onChange={(v) => props.onOptions({ convertHeic: v })}
                label={`Convert ${plural(heic, 'HEIC photo')} to JPG`}
                hint="JPG opens everywhere: older PCs, TVs, websites and printing shops. Date, camera and place are kept."
              >
                {options.convertHeic && (
                  <div className="segmented small imp-seg">
                    {(
                      [
                        ['aside', 'Keep HEIC in "HEIC originals"'],
                        ['next', 'Keep HEIC next to the JPG'],
                        ['none', "Don't keep HEIC"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        className={options.heicOriginals === value ? 'active' : ''}
                        aria-pressed={options.heicOriginals === value}
                        title={value === 'aside' ? `Recommended: the originals are kept but don't show up as duplicates${props.originalsDir ? `\n${props.originalsDir}` : ''}` : undefined}
                        onClick={() => props.onOptions({ heicOriginals: value })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </Switch>
            )}
            <Switch
              on={canDelete && options.deleteAfter}
              disabled={!canDelete}
              danger
              onChange={(v) => props.onOptions({ deleteAfter: v })}
              label={source.kind === 'folder' ? 'Remove the originals after importing' : `Remove from ${source.name} after importing`}
              hint={
                !canDelete
                  ? "Not available for phones: delete photos in the phone's own Photos or Gallery app once you've checked them here."
                  : source.kind === 'folder'
                    ? 'Each original goes to the Recycle Bin once its copy has been checked byte for byte.'
                    : 'Frees up the card. Each file is removed only after its copy has been checked byte for byte.'
              }
            />
          </div>
        </div>

        <div className="imp-go">
          <span className="imp-go-text">
            {count === 0
              ? counts.imported > 0 && options.skipImported
                ? 'Nothing new. Turn off "Skip files imported before" to import the deleted ones again.'
                : 'Nothing new to import: everything is already in your library.'
              : `${plural(count, 'file')}, ${formatBytes(bytes)}${counts.videos ? ` · ${plural(counts.videos, 'video')}` : ''}`}
          </span>
          <button className="btn primary large" disabled={count === 0 || !destination || props.starting} onClick={props.onImport}>
            {props.starting ? <LoaderCircle size={17} className="spin" /> : <Import size={17} />}{' '}
            {props.starting ? 'Starting…' : count === 0 ? 'Nothing to import' : `Import ${plural(count, 'file')}`}
          </button>
        </div>
      </section>

      <div className="imp-tabs" role="tablist">
        {tabs
          .filter((t) => t.key === 'new' || t.n > 0)
          .map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
              {t.label} <span className="imp-tab-n">{formatCount(t.n)}</span>
            </button>
          ))}
      </div>
      {shown.length === 0 ? (
        <p className="imp-empty">{tab === 'new' ? 'No new photos or videos.' : 'None.'}</p>
      ) : (
        <div className="imp-grid">
          {shown.slice(0, GRID_LIMIT).map((it) => (
            <Tile key={it.id} item={it} src={scan.thumbs ? props.thumb(it) : null} />
          ))}
        </div>
      )}
      {shown.length > GRID_LIMIT && <p className="imp-more">and {plural(shown.length - GRID_LIMIT, 'more')}</p>}
      {!scan.thumbs && shown.length > 0 && <p className="imp-note">Previews of phone photos appear once they're imported.</p>}
    </>
  )
}

// ----- 4. importing -----

function Importing(props: ImportViewProps & { progress: ImportProgress }) {
  const { progress: p, scan } = props
  const started = useRef(Date.now())
  const fraction = p.phase === 'copying' && p.totalBytes ? p.bytes / p.totalBytes : p.total ? p.done / p.total : 0
  // tick once a second so the time left stays fresh while a big video copies
  const [, setNow] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = p.phase === 'copying' ? eta(started.current, fraction) : null
  return (
    <section className="card imp-busy">
      <span className={`imp-source-icon ${scan?.source.kind ?? 'drive'}`}>{scan ? <SourceIcon source={scan.source} /> : <Import size={22} />}</span>
      <div className="imp-busy-body">
        <h2>{scan ? `Importing from ${scan.source.name}` : 'Importing'}</h2>
        <p className="imp-busy-line">
          <LoaderCircle size={15} className="spin" />
          {PHASE[p.phase]} {formatCount(Math.min(p.done + (p.phase === 'copying' && p.done < p.total ? 1 : 0), p.total))} of {formatCount(p.total)}
          {p.name ? <span className="imp-busy-name"> · {p.name}</span> : null}
        </p>
        <Bar pct={fraction * 100} />
        <p className="imp-note">
          {p.phase === 'copying' && p.totalBytes ? `${formatBytes(p.bytes)} of ${formatBytes(p.totalBytes)}` : ''}
          {left ? ` · ${left}` : ''}
          {scan?.source.kind === 'device' ? ' · Keep the phone unlocked and connected.' : ''}
        </p>
      </div>
      <button className="btn" onClick={props.onCancel}>
        Stop
      </button>
    </section>
  )
}

// ----- 5. done -----

function Done(props: ImportViewProps & { result: ImportResult }) {
  const { result: r, scan } = props
  const [open, setOpen] = useState(false)
  const problems = [...r.errors, ...r.warnings]
  const ok = r.errors.length === 0 && !r.cancelled
  const title = r.cancelled
    ? `Stopped after ${plural(r.imported, 'file')}`
    : r.imported
      ? `Imported ${plural(r.imported, 'file')}`
      : r.alreadyHad
        ? 'Everything was already in your library'
        : 'Nothing was imported'
  const lines: string[] = []
  if (r.imported) lines.push(`${formatBytes(r.bytes)} copied into ${baseName(r.destination)}, sorted into folders by date.`)
  if (r.converted) lines.push(`${plural(r.converted, 'HEIC photo')} converted to JPG.`)
  if (r.alreadyHad) lines.push(`${plural(r.alreadyHad, 'file')} turned out to be in your library already, so ${r.alreadyHad === 1 ? 'it was' : 'they were'} left out.`)
  if (r.removed) lines.push(`${plural(r.removed, 'file')} removed from ${scan?.source.name ?? 'the source'}.`)
  if (r.imported) lines.push('You can undo this from History: the imported copies go to the Recycle Bin.')
  return (
    <section className="card imp-done">
      <span className={`imp-done-icon${ok ? '' : ' warn'}`}>{ok ? <CircleCheck size={26} /> : <CircleAlert size={26} />}</span>
      <div className="imp-done-body">
        <h2>{title}</h2>
        {lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        {problems.length > 0 && (
          <div className="imp-problems">
            <button className="link" onClick={() => setOpen(!open)}>
              {open ? 'Hide' : 'Show'} {plural(r.errors.length, 'problem')}
              {r.warnings.length ? ` and ${plural(r.warnings.length, 'note')}` : ''}
            </button>
            {open && (
              <ul>
                {problems.map((e, i) => (
                  <li key={i} className={i < r.errors.length ? 'error' : ''}>
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="imp-done-actions">
          {r.imported > 0 && (
            <button className="btn primary" onClick={() => props.onOpenFolder(r.destination)}>
              <FolderOpen size={15} /> Open folder
            </button>
          )}
          <button className="btn" onClick={props.onBack}>
            <Import size={15} /> Import more
          </button>
          {r.entryId && props.onUndo && (
            <button className="btn ghost" onClick={() => props.onUndo!(r.entryId!)}>
              <Undo2 size={15} /> Undo
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

// ---------- parts ----------

function Bar({ pct }: { pct: number | null }) {
  return (
    <div className={`imp-bar${pct === null ? ' indeterminate' : ''}`}>
      <span style={pct === null ? undefined : { width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  )
}

function Stat({ value, label, sub, tone, title }: { value: string; label: string; sub?: string; tone?: 'accent' | 'amber'; title?: string }) {
  return (
    <div className={`imp-stat${tone ? ` ${tone}` : ''}`} title={title}>
      <span className="imp-stat-value">{value}</span>
      <span className="imp-stat-label">{label}</span>
      {sub && <span className="imp-stat-sub">{sub}</span>}
    </div>
  )
}

function Switch({
  on,
  onChange,
  label,
  hint,
  disabled = false,
  danger = false,
  extra,
  children,
}: {
  on: boolean
  onChange(v: boolean): void
  label: string
  hint?: string
  disabled?: boolean
  danger?: boolean
  extra?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={`imp-switch${disabled ? ' disabled' : ''}`}>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`switch${on ? ' on' : ''}${danger ? ' danger' : ''}`}
        onClick={() => !disabled && onChange(!on)}
        disabled={disabled}
      >
        <span />
      </button>
      <div className="imp-switch-text">
        <span className="imp-switch-label">
          {label} {extra}
        </span>
        {hint && <span className="imp-switch-hint">{hint}</span>}
        {children}
      </div>
    </div>
  )
}

function Tile({ item, src }: { item: ImportCandidate; src: string | null }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  const heic = item.ext === 'heic' || item.ext === 'heif'
  const tip = `${item.name}\n${dayFmt.format(item.date)} · ${formatBytes(item.size)}${item.match ? `\nIn your library: ${item.match}` : ''}${item.likely ? '\n(same name or date, and size)' : ''}`
  return (
    <div className={`imp-tile${src && !failed ? '' : ' plain'}`} title={tip}>
      {src && !failed ? (
        <img src={src} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="imp-tile-icon">{item.type === 'video' ? <Film size={20} /> : failed ? <ImageOff size={20} /> : <FileImage size={20} />}</span>
      )}
      {(!src || failed) && <span className="imp-tile-name">{item.name}</span>}
      {item.type === 'video' && src && !failed && (
        <span className="imp-badge">
          <Film size={11} />
        </span>
      )}
      {heic && <span className="imp-badge text">HEIC</span>}
    </div>
  )
}
