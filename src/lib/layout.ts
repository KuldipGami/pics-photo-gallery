import type { MediaItem } from '../types'
import { formatDayHeader, formatMonthHeader } from './format'

export const GRID_GAP = 4
export const PAD_LEFT = 28
export const PAD_RIGHT = 44
const PAD_TOP = 4
const PAD_BOTTOM = 40
const HEADER_HEIGHT = 52

export interface HeaderRow {
  kind: 'header'
  key: string
  top: number
  height: number
  label: string
  date: number
  /** Item index range [start, end) covered by this group. */
  start: number
  end: number
}

export interface ItemsRow {
  kind: 'items'
  key: string
  top: number
  height: number
  start: number
  end: number
}

export type Row = HeaderRow | ItemsRow

export interface GridLayout {
  rows: Row[]
  headers: HeaderRow[]
  total: number
  cols: number
  cell: number
  mode: 'day' | 'month'
}

const dayKey = (ts: number) => {
  const d = new Date(ts)
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate()
}
const monthKey = (ts: number) => {
  const d = new Date(ts)
  return d.getFullYear() * 100 + d.getMonth()
}

/**
 * Lays out a date-grouped square grid. Items must already be sorted by `field`.
 * Every row has a fixed, known height so the grid can be virtualised cheaply.
 */
export function buildLayout(
  items: MediaItem[],
  field: 'date' | 'added',
  width: number,
  target: number,
): GridLayout {
  const cols = Math.max(2, Math.floor((width + GRID_GAP) / (target + GRID_GAP)))
  const cell = Math.max(40, (width - GRID_GAP * (cols - 1)) / cols)
  const mode = target < 110 ? 'month' : 'day'
  const keyFn = mode === 'month' ? monthKey : dayKey
  const rows: Row[] = []
  const headers: HeaderRow[] = []
  let y = PAD_TOP
  let i = 0

  while (i < items.length) {
    const key = keyFn(items[i][field])
    let end = i + 1
    while (end < items.length && keyFn(items[end][field]) === key) end++

    const header: HeaderRow = {
      kind: 'header',
      key: `h${key}-${i}`,
      top: y,
      height: HEADER_HEIGHT,
      label: mode === 'month' ? formatMonthHeader(items[i][field]) : formatDayHeader(items[i][field]),
      date: items[i][field],
      start: i,
      end,
    }
    rows.push(header)
    headers.push(header)
    y += HEADER_HEIGHT

    for (let s = i; s < end; s += cols) {
      rows.push({ kind: 'items', key: `r${s}`, top: y, height: cell, start: s, end: Math.min(s + cols, end) })
      y += cell + GRID_GAP
    }
    i = end
  }

  return { rows, headers, total: y + PAD_BOTTOM, cols, cell, mode }
}

/** Index of the last row whose top is <= y. */
export function findRow(rows: { top: number }[], y: number) {
  let lo = 0
  let hi = rows.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].top <= y) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** The items row that contains item `index`. */
export function rowOfIndex(layout: GridLayout, index: number): ItemsRow | undefined {
  let lo = 0
  let hi = layout.rows.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const row = layout.rows[mid]
    if (index < row.start) hi = mid - 1
    else if (index >= row.end) lo = mid + 1
    else if (row.kind === 'items') return row
    else lo = mid + 1
  }
  return undefined
}
