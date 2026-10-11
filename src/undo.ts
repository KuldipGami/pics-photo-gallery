import { useSyncExternalStore } from 'react'
import { api } from './api'
import { formatCount } from './lib/format'

/**
 * Ctrl+Z: what the user did that can be taken back, newest last. Each step puts back exactly what
 * its action changed (the ratings the photos had before, the files a move took, the groups a merge
 * joined…), not a guess. Undoing goes newest first; an undo can't be redone.
 *
 * People and albums keep their own step lists in the main process (one step per action there too),
 * so their steps here only say "undo the latest one of those": they have to be undone in order.
 */
export interface UndoStep {
  /** What the action did, shown as "Undid: …" ("Moved 3 files to the Recycle Bin"). */
  label: string
  /** 'people' / 'albums': undone through the main process's own list, so only newest first. */
  area?: 'people' | 'albums'
  /**
   * The action changed nothing (an album already holding the photos…). Kept only so the main
   * process's list stays in step: it's undone quietly on the way to the step before.
   */
  empty?: boolean
  /** Puts it back. Resolves to the message to show (else "Undid: <label>"). */
  undo(): Promise<string | void> | string | void
}

const MAX = 50
let steps: UndoStep[] = []
let busy = false
const listeners = new Set<() => void>()
const emit = () => {
  for (const fn of listeners) fn()
}

export function pushUndo(step: UndoStep) {
  steps = [...steps, step].slice(-MAX)
  emit()
}

/** Forget the steps of `area` (all with none): the data they'd act on was deleted. */
export function clearUndo(area?: UndoStep['area']) {
  steps = area ? steps.filter((s) => s.area !== area) : []
  emit()
}

/** What Ctrl+Z would take back now (steps that changed nothing don't count). */
export const latestStep = (list: readonly UndoStep[]) => [...list].reverse().find((s) => !s.empty)

/**
 * Undoes `step` (default: the newest). An older people/album step can't jump the queue: undoing it
 * would take back the newer change of that kind instead. Resolves to the message to show, or null
 * when there was nothing to do.
 */
export async function undo(step: UndoStep | undefined = latestStep(steps)): Promise<{ message: string; error?: boolean } | null> {
  if (!step || busy) return null
  const at = steps.indexOf(step)
  if (at < 0) return { message: 'That was already undone' }
  const newer = steps.slice(at + 1)
  if (step.area && newer.some((s) => s.area === step.area && !s.empty)) return { message: 'Undo the newer changes first (Ctrl+Z)', error: true }
  // the empty steps of that kind on top go first, so the main process undoes the right one
  const quiet = step.area ? newer.filter((s) => s.area === step.area) : []
  busy = true
  steps = steps.filter((s) => s !== step && !quiet.includes(s))
  emit()
  try {
    for (const s of quiet.reverse()) await s.undo()
    const message = await step.undo()
    return { message: message || `Undid: ${step.label}` }
  } catch (err) {
    return { message: `Couldn't undo that: ${String((err as Error)?.message ?? err)}`, error: true }
  } finally {
    busy = false
  }
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
/** The steps there are now, newest last (re-renders when it changes). */
export function useUndoSteps(): readonly UndoStep[] {
  return useSyncExternalStore(subscribe, () => steps)
}

/**
 * Runs a change to files (Recycle Bin, a move, an edit, Organize…) and notes the History entries
 * it made. `restore` puts exactly those back, newest first (null when nothing was recorded).
 */
export async function fileChanges<T>(run: () => Promise<T>): Promise<{ res: T; restore: ((label: string) => Promise<string>) | null }> {
  const since = Date.now()
  const res = await run()
  const ids = await api.historySince(since).catch(() => [] as string[])
  return { res, restore: ids.length ? (label) => restoreEntries(ids, label) : null }
}

/**
 * fileChanges() recorded as one Ctrl+Z step. `label` can depend on the result. Resolves to the
 * result and the step (null when nothing was recorded).
 */
export async function withFileUndo<T>(label: string | ((res: T) => string), run: () => Promise<T>): Promise<{ res: T; step: UndoStep | null }> {
  const { res, restore } = await fileChanges(run)
  if (!restore) return { res, step: null }
  const text = typeof label === 'function' ? label(res) : label
  const step: UndoStep = { label: text, undo: () => restore(text) }
  pushUndo(step)
  return { res, step }
}

async function restoreEntries(ids: string[], label: string) {
  // (put back from History meanwhile: nothing left to do)
  const entries = (await api.historyList()).filter((e) => ids.includes(e.id))
  if (entries.length && entries.every((e) => e.files.every((f) => f.restored) && (e.dateChanges ?? []).every((c) => c.restored)))
    return `Already put back from History: ${label}`
  let restored = 0
  let total = 0
  for (const id of ids) {
    const r = await api.restoreHistory(id)
    restored += r.restored
    total += r.total ?? 0
  }
  if (!restored) throw new Error('the files were moved or renamed since, or their old place is taken')
  if (restored >= total) return `Undid: ${label}`
  return `Put back ${formatCount(restored)} of ${formatCount(total)} files; the rest were moved or renamed since`
}
