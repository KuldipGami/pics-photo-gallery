import { Archive, CircleAlert, CircleCheck, FolderOpen, LoaderCircle, Share } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, formatCount } from '../lib/format'
import type { MediaItem } from '../types'
import { useDialogKeys } from './PersonDialogs'
import './export.css'

/**
 * Export & share: copies of the selected photos and videos for sending, into a folder or one .zip
 * file (electron/exporter.cjs does the work). Props-driven: everything that talks to the main
 * process goes through `bridge`, so the dialog never calls IPC itself. Originals are never changed.
 */

// ---------- data (same shapes as electron/exporter.cjs) ----------

export type ExportSize = 'original' | 'large' | 'medium' | 'small'

export interface ExportOptions {
  size: ExportSize
  /** Keep each file's type (HEIC / RAW become JPG only when they have to change) or make every photo a JPG. */
  format: 'keep' | 'jpg'
  /** JPG / WebP quality, 40–100. */
  quality: number
  removeLocation: boolean
  /** Camera, dates, location and every other detail (implies removeLocation). */
  removeMetadata: boolean
  naming: 'keep' | 'date' | 'sequence'
  /** "Trip to Rome" → "Trip to Rome 001.jpg" (naming: 'sequence'). */
  baseName: string
  destination: 'folder' | 'zip'
  folder?: string
  zipPath?: string
}

export interface ExportProgress {
  done: number
  total: number
  bytes: number
  /** Name of the file being written. */
  current: string
  /** 0–1, including how far the current file is. */
  fraction: number
}

export interface ExportResult {
  ok: boolean
  canceled: boolean
  kind: 'folder' | 'zip'
  /** The folder, or the .zip file. */
  destination: string
  count: number
  total: number
  bytes: number
  failed: number
  /** "name: reason" */
  errors: string[]
  /** HEIC / RAW / PNG… photos saved as JPG. */
  converted: number
  /** Videos whose details couldn't be removed (not MP4 / MOV). */
  keptVideoDetails: number
  ms: number
}

/** What the dialog needs from the app (wire to the export:* IPC handlers). */
export interface ExportBridge {
  /** Default destinations for this export (Pictures\Lumen exports\<label>) and the last used options. */
  defaults(label: string): Promise<{ folder: string; zip: string; root: string; options: Partial<ExportOptions> | null }>
  /** Folder picker (kind 'folder') or save dialog for a .zip; null when cancelled. */
  pick(kind: 'folder' | 'zip', current: string): Promise<string | null>
  start(ids: string[], options: ExportOptions, label: string): Promise<ExportResult>
  cancel(): Promise<void>
  /** null when an export finished. Returns an unsubscribe function. */
  onProgress(cb: (progress: ExportProgress | null) => void): () => void
  /** Opens the folder, or shows the .zip in Explorer. */
  reveal(path: string): Promise<void>
}

export const EXPORT_DEFAULTS: ExportOptions = {
  size: 'original',
  format: 'keep',
  quality: 85,
  removeLocation: false,
  removeMetadata: false,
  naming: 'keep',
  baseName: '',
  destination: 'folder',
}

type PresetKey = 'originals' | 'share' | 'small'

/** Same values as PRESETS in electron/exporter.cjs. */
export const EXPORT_PRESETS: Record<PresetKey, { label: string; hint: string; options: Partial<ExportOptions> }> = {
  originals: {
    label: 'Originals',
    hint: 'Full size and quality, every detail kept',
    options: { size: 'original', format: 'keep', removeLocation: false, removeMetadata: false },
  },
  share: {
    label: 'For WhatsApp & email',
    hint: '1600 px JPGs without the location: small, sharp on any phone',
    options: { size: 'medium', format: 'jpg', quality: 82, removeLocation: true, removeMetadata: false },
  },
  small: {
    label: 'Smallest',
    hint: '1080 px JPGs without the location: for slow connections and size limits',
    options: { size: 'small', format: 'jpg', quality: 78, removeLocation: true, removeMetadata: false },
  },
}

const SIZE_CHOICES: { value: ExportSize; label: string; px: number }[] = [
  { value: 'original', label: 'Original', px: 0 },
  { value: 'large', label: 'Large', px: 2560 },
  { value: 'medium', label: 'Medium', px: 1600 },
  { value: 'small', label: 'Small', px: 1080 },
]

const SHARP_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff'])
const JPEG_EXT = new Set(['jpg', 'jpeg', 'jfif', 'jpe'])
const DETAIL_VIDEOS = new Set(['mp4', 'm4v', 'mov', '3gp', '3g2'])
const EMAIL_LIMIT = 25 * 1024 * 1024

const plural = (n: number, word: string, many = `${word}s`) => `${formatCount(n)} ${n === 1 ? word : many}`

/** Will this photo be saved as a JPG made from a different type? (HEIC / RAW / BMP, or "make JPG".) */
function becomesJpg(item: MediaItem, o: ExportOptions) {
  if (item.type !== 'image' || JPEG_EXT.has(item.ext)) return false
  if (o.format === 'jpg') return true
  return !SHARP_EXT.has(item.ext) && (o.size !== 'original' || o.removeLocation || o.removeMetadata)
}

/** JPG bytes per pixel at a quality (rough, for typical phone photos). */
const bytesPerPixel = (q: number) => 0.1 * Math.pow(1.038, Math.min(95, q) - 60) * (q >= 98 ? 2 : 1)

/** Rough size of the export and what's worth telling before it starts. */
export function estimateExport(items: MediaItem[], o: ExportOptions) {
  const long = SIZE_CHOICES.find((s) => s.value === o.size)?.px ?? 0
  let bytes = 0
  let photos = 0
  let videos = 0
  let toJpg = 0
  let heic = 0
  let videosKeepDetails = 0
  for (const it of items) {
    if (it.type === 'video') {
      videos++
      bytes += it.size
      if ((o.removeLocation || o.removeMetadata) && !DETAIL_VIDEOS.has(it.ext)) videosKeepDetails++
      continue
    }
    photos++
    const jpg = becomesJpg(it, o)
    if (jpg) toJpg++
    if (jpg && !SHARP_EXT.has(it.ext)) heic++
    const reencode = jpg || long > 0
    if (!reencode) {
      bytes += it.size
      continue
    }
    // Pixels: guessed from the file size (≈0.4 bytes per pixel for camera JPGs), 12 MP for others.
    const srcPixels = JPEG_EXT.has(it.ext) ? Math.max(1, it.size / 0.4) : 12e6
    const outPixels = long ? Math.min(srcPixels, long * long * 0.75) : srcPixels
    const outJpg = jpg || JPEG_EXT.has(it.ext)
    const guess = outJpg ? outPixels * bytesPerPixel(o.quality) : it.size * (outPixels / srcPixels)
    bytes += long ? Math.min(it.size, guess) : guess
  }
  return { bytes: Math.round(bytes), photos, videos, toJpg, heic, videosKeepDetails }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
function dateName(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
}

/** An example of the names the export gives (for the "Names" row). */
export function exampleName(items: MediaItem[], o: ExportOptions, label: string) {
  const first = [...items].sort((a, b) => (o.naming === 'keep' ? 0 : (a.taken ?? a.date) - (b.taken ?? b.date)))[0]
  if (!first) return ''
  const ext = first.type === 'video' ? first.ext : becomesJpg(first, o) ? 'jpg' : first.ext
  if (o.naming === 'date') return `${dateName(first.taken ?? first.date)}.${ext}`
  if (o.naming === 'sequence') {
    const base = (o.baseName || label || 'Photo').trim() || 'Photo'
    return `${base} ${'1'.padStart(Math.max(3, String(items.length).length), '0')}.${ext}`
  }
  return `${first.name.replace(/\.[^.]+$/, '')}.${ext}`
}

export function exportQualityHint(q: number) {
  if (q >= 92) return `${q}: best, larger files`
  if (q >= 80) return `${q}: looks the same, recommended`
  if (q >= 65) return `${q}: smaller, slight softening`
  return `${q}: smallest, visible loss`
}

function presetOf(o: ExportOptions): PresetKey | null {
  for (const key of Object.keys(EXPORT_PRESETS) as PresetKey[]) {
    const p = EXPORT_PRESETS[key].options
    if ((Object.keys(p) as (keyof ExportOptions)[]).every((k) => p[k] === o[k])) return key
  }
  return null
}

/** The result in one sentence (for a toast after the dialog closes, too). */
export function exportResultText(r: ExportResult) {
  if (r.canceled) return r.kind === 'zip' || r.count === 0 ? 'Export stopped. Nothing was saved.' : `Export stopped. ${plural(r.count, 'file')} of ${formatCount(r.total)} were saved.`
  if (r.count === 0) return `Nothing was exported. ${r.errors[0] ?? ''}`.trim()
  const what = `${plural(r.count, 'file')} (${formatBytes(r.bytes)})`
  if (r.failed) return `Exported ${what}; ${plural(r.failed, 'file')} couldn't be exported.`
  return r.kind === 'zip' ? `Saved ${what} in one .zip file.` : `Exported ${what}.`
}

// ---------- dialog ----------

type Phase = { kind: 'options' } | { kind: 'running'; stopping: boolean } | { kind: 'done'; result: ExportResult }

export interface ExportDialogProps {
  items: MediaItem[]
  /** Album / trip / place name: names the export folder and numbered files. Empty = today's date. */
  label?: string
  bridge: ExportBridge
  onClose(): void
  /** Called once with the result (e.g. for a toast or to refresh the library when exporting into it). */
  onDone?(result: ExportResult): void
}

export function ExportDialog({ items, label = '', bridge, onClose, onDone }: ExportDialogProps) {
  const [o, setO] = useState<ExportOptions>({ ...EXPORT_DEFAULTS, baseName: label })
  const [dest, setDest] = useState<{ folder: string; zip: string } | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'options' })
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const startRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    bridge.defaults(label).then((d) => {
      if (!live) return
      setDest({ folder: d.folder, zip: d.zip })
      if (d.options) setO((cur) => ({ ...cur, ...d.options, baseName: label || d.options?.baseName || '', folder: undefined, zipPath: undefined }))
    })
    return () => {
      live = false
    }
  }, [bridge, label])

  useEffect(() => bridge.onProgress((p) => p && setProgress(p)), [bridge])
  useEffect(() => startRef.current?.focus(), [dest])

  const set = (patch: Partial<ExportOptions>) => setO((cur) => ({ ...cur, ...patch }))
  const est = useMemo(() => estimateExport(items, o), [items, o])
  const preset = presetOf(o)
  const running = phase.kind === 'running'
  const reencodes = o.size !== 'original' || o.format === 'jpg' || est.heic > 0
  const target = o.destination === 'zip' ? dest?.zip : dest?.folder

  const start = async () => {
    if (!target || running || !items.length) return
    setPhase({ kind: 'running', stopping: false })
    setProgress({ done: 0, total: items.length, bytes: 0, current: '', fraction: 0 })
    const options = { ...o, folder: dest?.folder, zipPath: dest?.zip }
    const result = await bridge.start(
      items.map((it) => it.id),
      options,
      label,
    )
    setPhase({ kind: 'done', result })
    onDone?.(result)
  }
  const cancel = () => {
    if (phase.kind !== 'running') return
    setPhase({ kind: 'running', stopping: true })
    bridge.cancel()
  }
  const change = async () => {
    if (!dest) return
    const kind = o.destination
    const picked = await bridge.pick(kind, kind === 'zip' ? dest.zip : dest.folder)
    if (picked) setDest((d) => d && (kind === 'zip' ? { ...d, zip: /\.zip$/i.test(picked) ? picked : `${picked}.zip` } : { ...d, folder: picked }))
  }

  useDialogKeys((e) => {
    if (e.key === 'Escape') {
      if (phase.kind === 'running') cancel()
      else onClose()
    }
    if (e.key === 'Enter' && phase.kind === 'options' && !(e.target as HTMLElement)?.closest?.('input, select, button')) start()
  })

  const title =
    phase.kind === 'done'
      ? phase.result.canceled
        ? 'Export stopped'
        : phase.result.count === 0
          ? 'Nothing was exported'
          : 'Export finished'
      : `Export ${[est.photos ? plural(est.photos, 'photo') : '', est.videos ? plural(est.videos, 'video') : ''].filter(Boolean).join(' and ')}`

  return (
    <div className="modal-backdrop" onMouseDown={running ? undefined : onClose}>
      <div className="modal exp-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="exp-title">
          <span className="exp-title-icon">
            <Share size={18} />
          </span>
          <h3>{title}</h3>
        </div>

        {phase.kind === 'options' && (
          <>
            <div className="exp-presets" role="radiogroup" aria-label="Quick choices">
              {(Object.keys(EXPORT_PRESETS) as PresetKey[]).map((key) => (
                <button
                  key={key}
                  role="radio"
                  aria-checked={preset === key}
                  className={`exp-preset${preset === key ? ' active' : ''}`}
                  onClick={() => set({ ...EXPORT_PRESETS[key].options })}
                >
                  <span className="exp-preset-name">{EXPORT_PRESETS[key].label}</span>
                  <span className="exp-preset-hint">{EXPORT_PRESETS[key].hint}</span>
                </button>
              ))}
            </div>

            <div className="exp-form">
              <span className="exp-label">Size</span>
              <div>
                <div className="segmented small exp-seg">
                  {SIZE_CHOICES.map((s) => (
                    <button key={s.value} className={o.size === s.value ? 'active' : ''} aria-pressed={o.size === s.value} onClick={() => set({ size: s.value })} title={s.px ? `Longest side ${s.px} pixels (smaller photos stay as they are)` : 'Full size'}>
                      {s.label}
                      {s.px ? <span className="exp-px">{s.px}</span> : null}
                    </button>
                  ))}
                </div>
              </div>

              <span className="exp-label">Photos</span>
              <div>
                <div className="segmented small exp-seg">
                  <button className={o.format === 'keep' ? 'active' : ''} aria-pressed={o.format === 'keep'} onClick={() => set({ format: 'keep' })}>
                    Keep their type
                  </button>
                  <button className={o.format === 'jpg' ? 'active' : ''} aria-pressed={o.format === 'jpg'} onClick={() => set({ format: 'jpg' })}>
                    Save all as JPG
                  </button>
                </div>
                {reencodes && (
                  <div className="exp-quality">
                    <input type="range" min={50} max={100} step={1} value={o.quality} aria-label="JPG quality" onChange={(e) => set({ quality: Number(e.target.value) })} />
                    <span className="exp-hint">Quality {exportQualityHint(o.quality)}</span>
                  </div>
                )}
              </div>

              <span className="exp-label">Details</span>
              <div className="exp-switches">
                <label className="exp-switch">
                  <button
                    role="switch"
                    aria-checked={o.removeLocation || o.removeMetadata}
                    className={`switch${o.removeLocation || o.removeMetadata ? ' on' : ''}`}
                    disabled={o.removeMetadata}
                    onClick={() => set({ removeLocation: !o.removeLocation })}
                  >
                    <span />
                  </button>
                  <span>
                    Remove location
                    <span className="exp-hint block">Where each photo was taken (GPS) is left out.</span>
                  </span>
                </label>
                <label className="exp-switch">
                  <button
                    role="switch"
                    aria-checked={o.removeMetadata}
                    className={`switch${o.removeMetadata ? ' on' : ''}`}
                    onClick={() => set({ removeMetadata: !o.removeMetadata, removeLocation: !o.removeMetadata ? true : o.removeLocation })}
                  >
                    <span />
                  </button>
                  <span>
                    Remove all details
                    <span className="exp-hint block">Camera, dates, location and other tags. Files get today's date.</span>
                  </span>
                </label>
              </div>

              <span className="exp-label">Names</span>
              <div>
                <select className="exp-select" value={o.naming} onChange={(e) => set({ naming: e.target.value as ExportOptions['naming'] })} aria-label="File names">
                  <option value="keep">Keep their names</option>
                  <option value="date">Date taken (2024-06-01 14.30.05)</option>
                  <option value="sequence">A name and a number</option>
                </select>
                {o.naming === 'sequence' && (
                  <input className="exp-input" value={o.baseName} maxLength={80} placeholder="e.g. Trip to Rome" aria-label="Name for the files" onChange={(e) => set({ baseName: e.target.value })} />
                )}
                <div className="exp-hint">Like “{exampleName(items, o, label)}”</div>
              </div>

              <span className="exp-label">Save to</span>
              <div>
                <div className="segmented small exp-seg">
                  <button className={o.destination === 'folder' ? 'active' : ''} aria-pressed={o.destination === 'folder'} onClick={() => set({ destination: 'folder' })}>
                    <FolderOpen size={14} /> A folder
                  </button>
                  <button className={o.destination === 'zip' ? 'active' : ''} aria-pressed={o.destination === 'zip'} onClick={() => set({ destination: 'zip' })}>
                    <Archive size={14} /> One .zip file
                  </button>
                </div>
                <div className="exp-dest">
                  {o.destination === 'zip' ? <Archive size={15} /> : <FolderOpen size={15} />}
                  <span className="exp-dest-path" title={target}>
                    {target ?? 'Working out a folder…'}
                  </span>
                  <button className="link" onClick={change} disabled={!dest}>
                    Change…
                  </button>
                </div>
              </div>
            </div>

            <Notes est={est} o={o} />

            <div className="modal-actions exp-actions">
              <span className="exp-estimate" title="A rough guess: the real size depends on the photos">
                {plural(items.length, 'file')} · about {formatBytes(est.bytes)}
              </span>
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button ref={startRef} className="btn primary" disabled={!target || !items.length} onClick={start}>
                <Share size={15} /> Export
              </button>
            </div>
          </>
        )}

        {phase.kind === 'running' && (
          <div className="exp-running" aria-live="polite">
            <div className="exp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress?.fraction ?? 0) * 100)}>
              <span style={{ width: `${Math.max(2, (progress?.fraction ?? 0) * 100)}%` }} />
            </div>
            <div className="exp-running-text">
              <LoaderCircle size={15} className="spin" />
              <span>
                {phase.stopping
                  ? 'Stopping…'
                  : `Exporting ${formatCount(Math.min((progress?.done ?? 0) + 1, progress?.total ?? items.length))} of ${formatCount(progress?.total ?? items.length)}`}
              </span>
              <span className="exp-running-file" title={progress?.current}>
                {progress?.current}
              </span>
              <span className="exp-running-bytes">{formatBytes(progress?.bytes ?? 0)}</span>
            </div>
            <p className="exp-note">Your original files are only read, never changed.</p>
            <div className="modal-actions">
              <button className="btn" onClick={cancel} disabled={phase.stopping}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase.kind === 'done' && (
          <div className="exp-done">
            <div className={`exp-result${phase.result.ok ? ' ok' : phase.result.count ? ' partial' : ' bad'}`}>
              {phase.result.ok ? <CircleCheck size={20} /> : <CircleAlert size={20} />}
              <span>{exportResultText(phase.result)}</span>
            </div>
            {phase.result.count > 0 && (
              <div className="exp-dest">
                {phase.result.kind === 'zip' ? <Archive size={15} /> : <FolderOpen size={15} />}
                <span className="exp-dest-path" title={phase.result.destination}>
                  {phase.result.destination}
                </span>
              </div>
            )}
            {phase.result.count > 0 && (phase.result.converted > 0 || phase.result.keptVideoDetails > 0) && (
              <p className="exp-note">
                {[
                  phase.result.converted ? `${plural(phase.result.converted, 'photo was', 'photos were')} saved as JPG.` : '',
                  phase.result.keptVideoDetails ? `${plural(phase.result.keptVideoDetails, 'video')} kept ${phase.result.keptVideoDetails === 1 ? 'its' : 'their'} details (only MP4 and MOV videos can have them removed).` : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              </p>
            )}
            {phase.result.kind === 'zip' && phase.result.ok && phase.result.bytes > EMAIL_LIMIT && (
              <p className="exp-note">This .zip is larger than most email services accept (about 25 MB). A cloud drive link works better for it.</p>
            )}
            {phase.result.errors.length > 0 && (
              <div className="exp-errors">
                <button className="link" onClick={() => setShowErrors((s) => !s)}>
                  {showErrors ? 'Hide details' : `Show what went wrong (${formatCount(phase.result.errors.length)})`}
                </button>
                {showErrors && (
                  <ul>
                    {phase.result.errors.slice(0, 50).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="modal-actions">
              {phase.result.count > 0 && (
                <button className="btn" onClick={() => bridge.reveal(phase.result.destination)}>
                  <FolderOpen size={15} /> {phase.result.kind === 'zip' ? 'Show the .zip file' : 'Open folder'}
                </button>
              )}
              <button className="btn primary" onClick={onClose} autoFocus>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Notes({ est, o }: { est: ReturnType<typeof estimateExport>; o: ExportOptions }) {
  const notes: string[] = []
  if (est.heic > 0) notes.push(`${plural(est.heic, 'HEIC or RAW photo is', 'HEIC or RAW photos are')} saved as JPG, so they open everywhere.`)
  if (est.videos > 0)
    notes.push(
      o.removeLocation || o.removeMetadata
        ? `Videos are copied without re-compressing. ${est.videosKeepDetails ? `${plural(est.videosKeepDetails, 'video')} (not MP4 or MOV) ${est.videosKeepDetails === 1 ? 'keeps its' : 'keep their'} details. ` : ''}Some cameras (action cams, drones) also record the route inside the video itself; that stays.`
        : 'Videos are copied as they are, without re-compressing.',
    )
  if (!o.removeLocation && !o.removeMetadata && est.photos > 0) notes.push("Photos keep their location: anyone you send them to can see where they were taken.")
  if (o.destination === 'zip' && est.bytes > EMAIL_LIMIT) notes.push('About ' + formatBytes(est.bytes) + ': larger than most email services accept (about 25 MB).')
  if (!notes.length) return null
  return (
    <ul className="exp-notes">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  )
}
