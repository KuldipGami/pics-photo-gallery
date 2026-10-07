import { ArrowRight, CalendarClock, FileImage, FolderOpen, FolderTree, ImageOff, LoaderCircle, PenLine, RotateCcw, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { baseName, formatBytes, formatCount } from '../lib/format'
import type { DupGroup, MediaItem } from '../types'
import './organize.css'

/**
 * Organize (ported from DupeLens' Organize tab): fix dates from file names, sort into dated
 * folders, rename by date, turn sideways copies upright, convert HEIC photos to JPG.
 * Props-driven: the plan comes from the main process (electron/organize.cjs `summarize`) and every
 * action is a callback, so this component never talks to IPC itself.
 */

// ---------- data ----------

export interface OrganizeOption {
  value: string
  label: string
}

/** Same values as electron/organize.cjs FOLDER_PATTERNS (.NET date formats; `\\` = nested folder). */
export const FOLDER_PATTERNS: OrganizeOption[] = [
  { value: 'yyyy\\\\MM - MMMM', label: '2022\\12 - December' },
  { value: 'yyyy\\\\MM', label: '2022\\12' },
  { value: 'yyyy\\\\yyyy-MM-dd', label: '2022\\2022-12-16' },
  { value: 'yyyy-MM', label: '2022-12' },
  { value: 'yyyy', label: '2022' },
]

/** Same values as electron/organize.cjs NAME_PATTERNS. */
export const NAME_PATTERNS: OrganizeOption[] = [
  { value: 'yyyy-MM-dd HH.mm.ss', label: '2022-12-16 14.30.05' },
  { value: 'yyyyMMdd_HHmmss', label: '20221216_143005' },
  { value: 'yyyy-MM-dd {name}', label: '2022-12-16 IMG-20221216-WA0037' },
]

/** What the Organize view shows; produced by organize.summarize() in the main process. */
export interface OrganizePlan {
  /** Files whose name date disagrees with their file date (first 6 for the preview). */
  dateFixes: { count: number; preview: { name: string; from: number; to: number }[] }
  /** Moves into dated folders under `root` (first 8 folders, relative to root). */
  folders: { root: string; count: number; folders: number; preview: { folder: string; count: number }[] }
  /** Renames (first 6, old name → new name). */
  renames: { count: number; preview: { from: string; to: string }[] }
  /** HEIC photos that can be converted (not selected for removal), and ones Windows can't open. */
  heic: { count: number; bytes: number; unreadable: number }
}

/** The choices, saved by the app (defaults: ORGANIZE_DEFAULTS). */
export interface OrganizeOptions {
  folderPattern: string
  /** Sort into folders by copying (true) or moving (false). */
  copy: boolean
  renamePattern: string
  /** Rename only camera & phone names (IMG_, DSC, WhatsApp…). */
  deviceNamesOnly: boolean
  /** JPG quality 70–100. */
  jpegQuality: number
  /** Move HEIC originals to "HEIC originals" after converting (else keep them next to the JPGs). */
  moveOriginals: boolean
}

export const ORGANIZE_DEFAULTS: OrganizeOptions = {
  folderPattern: 'yyyy\\\\MM - MMMM',
  copy: false,
  renamePattern: 'yyyy-MM-dd HH.mm.ss',
  deviceNamesOnly: true,
  jpegQuality: 92,
  moveOriginals: true,
}

/** A JPEG copy turned differently from its group's best copy. */
export interface SidewaysRow {
  item: MediaItem
  reference: MediaItem
  /** Clockwise quarter turns that make the copy look like the best copy (1–3). */
  turns: number
}

export interface OrganizeActions {
  onFixDates(): void
  onOrganize(): void
  onRename(): void
  /** Turn these copies to match their best copy: one row's button, or all of them. */
  onTurn(ids: string[]): void
  onConvert(): void
  /** Choose where the dated folders go. */
  onChangeRoot(): void
  /** Save changed choices (the plan should then be refreshed). */
  onOptions(patch: Partial<OrganizeOptions>): void
  /** Open a photo (clicking a thumbnail in the sideways list). */
  onOpen?(item: MediaItem): void
}

export interface OrganizeViewProps extends OrganizeActions {
  /** null while the first plan is being worked out. */
  plan: OrganizePlan | null
  options: OrganizeOptions
  sideways: SidewaysRow[]
  /** Thumbnail URL for an item (thumbUrl from api.ts). */
  thumb(item: MediaItem): string
  /** An action is running: every action button is disabled. */
  busy?: boolean
  /** HEIC conversion progress while it runs. */
  converting?: { done: number; total: number } | null
  /** Where HEIC originals are moved ("<first library folder>\HEIC originals"). */
  originalsDir?: string
}

// ---------- helpers (also for the app's confirm dialogs and toasts) ----------

const JPEG_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif'])

/** JPEG copies that are turned differently from their group's best copy (fixable losslessly). */
export function findSideways(groups: DupGroup[], byId: Map<string, MediaItem>, skip?: Set<string>): SidewaysRow[] {
  const rows: SidewaysRow[] = []
  for (const g of groups) {
    const reference = byId.get(g.ids[g.ref])
    if (!reference) continue
    g.ids.forEach((id, i) => {
      const info = g.info[i]
      if (i === g.ref || info.length !== 3 || info[1] !== 'rotated' || !(info[2] > 0)) return
      const item = byId.get(id)
      if (!item || item.type !== 'image' || !JPEG_EXT.has(item.ext) || skip?.has(id)) return
      rows.push({ item, reference, turns: info[2] })
    })
  }
  return rows
}

export const turnText = (turns: number) => (turns === 1 ? 'Turn right' : turns === 3 ? 'Turn left' : 'Turn upside down')

export function qualityHint(q: number) {
  if (q >= 96) return `Quality ${q}: maximum, large files`
  if (q >= 88) return `Quality ${q}: looks identical, recommended`
  if (q >= 80) return `Quality ${q}: smaller files, tiny loss`
  return `Quality ${q}: smallest files, visible loss`
}

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export type OrganizeAction = 'dates' | 'folders' | 'rename' | 'turn' | 'convert'

/** DupeLens' confirmation texts. `destination` (when set) is the folder to show under the message. */
export function organizeConfirm(
  action: OrganizeAction,
  plan: OrganizePlan,
  options: OrganizeOptions,
  extra: { turnCount?: number; originalsDir?: string } = {},
): { title: string; message: string; confirmLabel: string; destination?: string } {
  switch (action) {
    case 'dates':
      return {
        title: `Fix the date of ${plural(plan.dateFixes.count, 'file')}?`,
        message:
          "Each file's date in Windows is set to the date in its name, so your photos sort in the order they were taken. The photos themselves are not changed, and you can undo this from History.",
        confirmLabel: 'Fix dates',
      }
    case 'folders': {
      const like = FOLDER_PATTERNS.find((p) => p.value === options.folderPattern)?.label ?? ''
      const n = plan.folders.count
      return options.copy
        ? {
            title: `Copy ${plural(n, 'file')} into dated folders?`,
            message: `Copies are placed in folders like "${like}" under the folder below. The originals stay where they are.`,
            confirmLabel: 'Copy files',
            destination: plan.folders.root,
          }
        : {
            title: `Move ${plural(n, 'file')} into dated folders?`,
            message: `Files are moved into folders like "${like}" under the folder below. Nothing is overwritten, and you can undo this from History.`,
            confirmLabel: 'Move files',
            destination: plan.folders.root,
          }
    }
    case 'rename':
      return {
        title: `Rename ${plural(plan.renames.count, 'file')}?`,
        message: `Files get names like "${plan.renames.preview[0]?.to ?? ''}" based on when they were taken. You can undo this from History.`,
        confirmLabel: 'Rename files',
      }
    case 'turn':
      return {
        title: `Turn ${plural(extra.turnCount ?? 0, 'photo')}?`,
        message:
          'Each photo is turned to match the best copy in its group. Only the orientation tag inside the JPEG changes, so the picture keeps its full quality. You can undo this from History.',
        confirmLabel: 'Turn photos',
      }
    case 'convert':
      return options.moveOriginals
        ? {
            title: `Convert ${plural(plan.heic.count, 'HEIC photo')} to JPG?`,
            message:
              "Each photo is saved as a JPG next to the original, keeping its date, camera and location. The HEIC originals are then moved to the folder below so they don't show up as duplicates. You can undo this from History.",
            confirmLabel: 'Convert',
            destination: extra.originalsDir,
          }
        : {
            title: `Convert ${plural(plan.heic.count, 'HEIC photo')} to JPG?`,
            message:
              'Each photo is saved as a JPG next to the original, keeping its date, camera and location. The HEIC originals stay where they are, so each photo will exist twice until you remove one. You can undo this from History.',
            confirmLabel: 'Convert',
          }
  }
}

/** DupeLens' result toasts. `errors` are "name: reason" strings. */
export function organizeDoneText(action: OrganizeAction, done: number, errors: string[] = [], copy = false): { text: string; error: boolean } {
  const failed = errors.length
  const first = errors[0] ?? ''
  if (action === 'dates') return { text: `Fixed the date of ${plural(done, 'file')}.`, error: false }
  if (!failed) {
    const text =
      action === 'folders'
        ? `${copy ? 'Copied' : 'Organized'} ${plural(done, 'file')} into dated folders.`
        : action === 'rename'
          ? `Renamed ${plural(done, 'file')}.`
          : action === 'turn'
            ? `Turned ${plural(done, 'photo')}. Undo it from History if needed.`
            : `Converted ${plural(done, 'photo')} to JPG.`
    return { text, error: false }
  }
  const verb = { folders: 'Organized', rename: 'Renamed', turn: 'Turned', convert: 'Converted' }[action]
  if (action === 'turn') {
    const [name, ...why] = first.split(': ')
    return {
      text: done === 0 ? `Couldn't turn ${name}: ${why.join(': ')} Nothing was changed.` : `Turned ${formatCount(done)}, but ${name} couldn't be turned: ${why.join(': ')}`,
      error: true,
    }
  }
  return { text: `${verb} ${formatCount(done)}, ${formatCount(failed)} failed: ${first}`, error: true }
}

// ---------- view ----------

const EMPTY: OrganizePlan = {
  dateFixes: { count: 0, preview: [] },
  folders: { root: '', count: 0, folders: 0, preview: [] },
  renames: { count: 0, preview: [] },
  heic: { count: 0, bytes: 0, unreadable: 0 },
}

export function OrganizeView(props: OrganizeViewProps) {
  const { options, sideways, busy = false, converting } = props
  const loading = props.plan === null
  const plan = props.plan ?? EMPTY
  const checking = 'Checking your library…'

  // ----- fix dates -----
  const fixes = plan.dateFixes
  const dateSummary = loading
    ? checking
    : fixes.count === 0
      ? "Every file's date already matches the date in its name."
      : `${plural(fixes.count, 'file')} carry a date in their name (like WhatsApp's IMG-20221216-WA0037) but show a different date in Windows, usually the day they were received or copied.`

  // ----- dated folders -----
  const folders = plan.folders
  const root = folders.root
  const organizeSummary = loading
    ? checking
    : !root
      ? 'Choose a destination folder.'
      : folders.count === 0
        ? 'Everything is already in the right folder.'
        : `${plural(folders.count, 'file')} in "${baseName(root)}" go into ${plural(folders.folders, 'folder')} by the date they were taken. Files selected for removal are skipped; other scanned folders are left alone.`
  const organizeLabel = folders.count === 0 ? 'Nothing to organize' : `${options.copy ? 'Copy' : 'Move'} ${plural(folders.count, 'file')}`

  // ----- rename -----
  const renames = plan.renames
  const renameLabel = renames.count === 0 ? 'Nothing to rename' : `Rename ${plural(renames.count, 'file')}`

  // ----- sideways -----
  const sidewaysSummary =
    sideways.length === 0
      ? 'Every copy is turned the same way as its best copy.'
      : `${plural(sideways.length, 'photo')} ${sideways.length === 1 ? 'is' : 'are'} turned differently from the best copy in their group. Turning only changes the orientation tag inside the JPEG, so there's no quality loss, and you can undo it from History.`
  const sidewaysLabel = sideways.length === 0 ? 'Nothing to turn' : `Turn ${plural(sideways.length, 'photo')}`

  // ----- HEIC -----
  const heic = plan.heic
  const showHeic = heic.count > 0 || heic.unreadable > 0 || !!converting
  const heicSummary =
    heic.count === 0 && heic.unreadable === 0
      ? 'No HEIC photos found.'
      : heic.count === 0
        ? `${plural(heic.unreadable, 'HEIC photo')} can't be opened yet. Install the free "HEIF Image Extensions" from Microsoft Store, then rescan.`
        : `${plural(heic.count, 'HEIC photo')} (${formatBytes(heic.bytes)}) from iPhones. JPG opens everywhere: older PCs, TVs, websites and printing shops.` +
          (heic.unreadable > 0 ? ` ${formatCount(heic.unreadable)} more can't be opened.` : '')
  const convertLabel = heic.count === 0 ? 'Nothing to convert' : `Convert ${plural(heic.count, 'photo')}`

  // The quality slider saves once it settles, not on every step.
  const [quality, setQuality] = useState(options.jpegQuality)
  useEffect(() => setQuality(options.jpegQuality), [options.jpegQuality])
  const onOptions = useRef(props.onOptions)
  onOptions.current = props.onOptions
  useEffect(() => {
    if (quality === options.jpegQuality) return
    const t = setTimeout(() => onOptions.current({ jpegQuality: quality }), 300)
    return () => clearTimeout(t)
  }, [quality, options.jpegQuality])

  const off = busy || loading

  return (
    <div className="org-scroll">
      <div className="org">
        {/* Fix dates */}
        <ToolCard
          icon={<CalendarClock size={19} />}
          tone="accent"
          title="Fix dates from file names"
          summary={dateSummary}
          action={
            <button className="btn primary" disabled={off || fixes.count === 0} onClick={props.onFixDates} title="Set file dates from the dates in their names">
              <CalendarClock size={15} /> {fixes.count === 0 ? 'Nothing to fix' : `Fix ${formatCount(fixes.count)} date${fixes.count === 1 ? '' : 's'}`}
            </button>
          }
        >
          {fixes.count > 0 && (
            <Preview more={fixes.count - fixes.preview.length} noun="file">
              {fixes.preview.map((r) => (
                <PreviewRow key={r.name + r.from} left={r.name} right={`${dateFmt.format(r.from)}  →  ${dateFmt.format(r.to)}`} />
              ))}
            </Preview>
          )}
        </ToolCard>

        {/* Sort into dated folders */}
        <ToolCard
          icon={<FolderTree size={19} />}
          tone="green"
          title="Sort into dated folders"
          summary={organizeSummary}
          action={
            <button className="btn primary" disabled={off || folders.count === 0} onClick={props.onOrganize}>
              <FolderTree size={15} /> {organizeLabel}
            </button>
          }
        >
          <div className="org-form">
            <span className="org-label">Into</span>
            <div className="org-root">
              <FolderOpen size={15} />
              <span className="org-root-path" title={root || undefined}>
                {root || 'No folder chosen'}
              </span>
              <button className="link" onClick={props.onChangeRoot} disabled={busy}>
                Change…
              </button>
            </div>
            <span className="org-label">Folders</span>
            <select className="org-select" value={options.folderPattern} onChange={(e) => props.onOptions({ folderPattern: e.target.value })} disabled={busy}>
              {FOLDER_PATTERNS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="org-label">Files</span>
            <div className="segmented small org-seg">
              <button className={!options.copy ? 'active' : ''} aria-pressed={!options.copy} onClick={() => props.onOptions({ copy: false })} disabled={busy}>
                Move
              </button>
              <button className={options.copy ? 'active' : ''} aria-pressed={options.copy} onClick={() => props.onOptions({ copy: true })} disabled={busy}>
                Copy (keep originals)
              </button>
            </div>
          </div>
          {folders.preview.length > 0 && (
            <Preview more={folders.folders - folders.preview.length} noun="folder">
              {folders.preview.map((r) => (
                <PreviewRow key={r.folder} left={r.folder} right={plural(r.count, 'file')} />
              ))}
            </Preview>
          )}
        </ToolCard>

        {/* Rename by date */}
        <ToolCard
          icon={<PenLine size={19} />}
          tone="amber"
          title="Rename by date"
          summary={
            loading ? checking : 'Gives files readable names based on when they were taken, so they sort correctly anywhere. Files selected for removal are skipped.'
          }
          action={
            <button className="btn primary" disabled={off || renames.count === 0} onClick={props.onRename}>
              <PenLine size={15} /> {renameLabel}
            </button>
          }
        >
          <div className="org-inline">
            <select className="org-select wide" value={options.renamePattern} onChange={(e) => props.onOptions({ renamePattern: e.target.value })} disabled={busy}>
              {NAME_PATTERNS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <label className="org-switch">
              <button
                role="switch"
                aria-checked={options.deviceNamesOnly}
                className={`switch${options.deviceNamesOnly ? ' on' : ''}`}
                onClick={() => props.onOptions({ deviceNamesOnly: !options.deviceNamesOnly })}
                disabled={busy}
              >
                <span />
              </button>
              Only camera &amp; phone names (IMG_, DSC, WhatsApp…)
            </label>
          </div>
          {renames.preview.length > 0 && (
            <Preview more={renames.count - renames.preview.length} noun="file">
              {renames.preview.map((r) => (
                <PreviewRow key={r.from} left={r.from} right={r.to} />
              ))}
            </Preview>
          )}
        </ToolCard>

        {/* Turn sideways copies upright */}
        <ToolCard
          icon={<RotateCw size={19} />}
          tone="accent"
          title="Turn sideways copies upright"
          summary={sidewaysSummary}
          action={
            <button className="btn primary" disabled={busy || sideways.length === 0} onClick={() => props.onTurn(sideways.map((r) => r.item.id))}>
              <RotateCw size={15} /> {sidewaysLabel}
            </button>
          }
        >
          {sideways.length > 0 && (
            <>
              <Preview more={sideways.length - Math.min(6, sideways.length)} noun="photo">
                {sideways.slice(0, 6).map((r) => (
                  <div className="org-turn" key={r.item.id}>
                    <Mini item={r.item} src={props.thumb(r.item)} onOpen={props.onOpen} />
                    <ArrowRight size={13} className="org-turn-arrow" />
                    <Mini item={r.reference} src={props.thumb(r.reference)} onOpen={props.onOpen} />
                    <div className="org-turn-text">
                      <div className="org-turn-name" title={r.item.path}>
                        {r.item.name}
                      </div>
                      <div className="org-turn-ref" title={r.reference.path}>
                        Turned differently from {r.reference.name}
                      </div>
                    </div>
                    <button className="btn" disabled={busy} onClick={() => props.onTurn([r.item.id])}>
                      {r.turns === 3 ? <RotateCcw size={14} /> : <RotateCw size={14} />} {turnText(r.turns)}
                    </button>
                  </div>
                ))}
              </Preview>
              <p className="org-note">
                Copies are turned to match the best copy in their group. If the best copy is the one that's sideways, turn it in the photo editor instead.
              </p>
            </>
          )}
        </ToolCard>

        {/* Convert HEIC to JPG */}
        {showHeic && (
          <ToolCard
            icon={<FileImage size={19} />}
            tone="green"
            title="Convert HEIC photos to JPG"
            summary={heicSummary}
            action={
              <button className="btn primary" disabled={off || heic.count === 0} onClick={props.onConvert}>
                <FileImage size={15} /> {convertLabel}
              </button>
            }
          >
            <div className="org-form">
              <span className="org-label">Quality</span>
              <div className="org-quality">
                <input
                  type="range"
                  min={70}
                  max={100}
                  step={1}
                  value={quality}
                  aria-label="JPG quality"
                  disabled={busy}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
                <span className="org-hint">{qualityHint(quality)}</span>
              </div>
              <span className="org-label">Originals</span>
              <div className="segmented small org-seg">
                <button
                  className={options.moveOriginals ? 'active' : ''}
                  aria-pressed={options.moveOriginals}
                  title={`Recommended: keeps both versions but stops them showing up as duplicates${props.originalsDir ? `\n${props.originalsDir}` : ''}`}
                  onClick={() => props.onOptions({ moveOriginals: true })}
                  disabled={busy}
                >
                  Move to "HEIC originals"
                </button>
                <button
                  className={!options.moveOriginals ? 'active' : ''}
                  aria-pressed={!options.moveOriginals}
                  onClick={() => props.onOptions({ moveOriginals: false })}
                  disabled={busy}
                >
                  Keep next to the JPGs
                </button>
              </div>
            </div>
            {converting && (
              <div className="org-progress">
                <LoaderCircle size={15} className="spin" />
                Converting {formatCount(converting.done)} of {formatCount(converting.total)}…
              </div>
            )}
          </ToolCard>
        )}

        <p className="org-footer">
          Every change here is listed in History and can be undone. Pictures are never re-compressed in place: turning a photo only changes a tag inside it, and
          conversion saves a new JPG.
        </p>
      </div>
    </div>
  )
}

// ---------- parts ----------

function ToolCard({
  icon,
  tone,
  title,
  summary,
  action,
  children,
}: {
  icon: ReactNode
  tone: 'accent' | 'green' | 'amber'
  title: string
  summary: string
  action: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="card org-card">
      <span className={`org-icon ${tone}`}>{icon}</span>
      <div className="org-body">
        <h2>{title}</h2>
        <p>{summary}</p>
        {children}
      </div>
      <div className="org-action">{action}</div>
    </section>
  )
}

function Preview({ children, more, noun }: { children: ReactNode; more: number; noun: string }) {
  return (
    <div className="org-preview">
      {children}
      {more > 0 && <div className="org-more">and {plural(more, `more ${noun}`)}</div>}
    </div>
  )
}

function PreviewRow({ left, right }: { left: string; right: string }) {
  return (
    <div className="org-row">
      <span className="org-row-left" title={left}>
        {left}
      </span>
      <span className="org-row-right" title={right}>
        {right}
      </span>
    </div>
  )
}

function Mini({ item, src, onOpen }: { item: MediaItem; src: string; onOpen?(item: MediaItem): void }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return (
    <button className="org-mini" title={item.name} onClick={onOpen ? () => onOpen(item) : undefined} tabIndex={onOpen ? 0 : -1}>
      {failed ? <ImageOff size={16} /> : <img src={src} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} />}
    </button>
  )
}
