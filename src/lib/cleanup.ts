import type { DupGroup, KeepRule, MediaItem } from '../types'
import { baseName, formatBytes, formatCount } from './format'

// Clean up: keep rules, finders and reports (ported from DupeLens).

export const KEEP_RULES: [KeepRule, string][] = [
  ['best', 'Highest quality'],
  ['sharpest', 'Sharpest photo'],
  ['largest', 'Largest file'],
  ['oldest', 'Oldest photo'],
  ['newest', 'Newest photo'],
]
const RULE_INDEX: Record<KeepRule, number> = { best: 0, sharpest: 1, largest: 2, oldest: 3, newest: 4 }

const norm = (p: string) => p.toLowerCase().replace(/[\\/]+$/, '')
export const isUnder = (file: string, folder: string) => {
  const f = norm(file)
  const d = norm(folder)
  return f === d || f.startsWith(d + '\\') || f.startsWith(d + '/')
}

/** A folder shown short: its path inside the library folder it belongs to ("Pictures\WhatsApp\Sent"). */
export function shortLocation(dir: string, roots: string[]) {
  const root = roots.filter((r) => isUnder(dir, r)).sort((a, b) => b.length - a.length)[0]
  if (!root) return dir
  const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
  const rest = dir.slice(root.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '')
  return rest ? `${name}\\${rest}` : name
}

export const makeProtected = (folders: string[]) => (item: MediaItem) => folders.some((f) => isUnder(item.path, f))

const always = () => true

/**
 * Keep order for a group: protected files first, then the rule's ranking (computed in the main
 * process). Only files `present` (still in the library) are ranked: the best copy may be gone.
 */
export function rank(group: DupGroup, rule: KeepRule, isProtected: (id: string) => boolean, present: (id: string) => boolean = always): number[] {
  const order = (group.orders[RULE_INDEX[rule]] ?? group.orders[0]).filter((i) => present(group.ids[i]))
  return [...order.filter((i) => isProtected(group.ids[i])), ...order.filter((i) => !isProtected(group.ids[i]))]
}

/** Marks for a group under a rule: every present file except the first in rank (protected files are never marked). */
export function ruleMarks(group: DupGroup, rule: KeepRule, isProtected: (id: string) => boolean, present: (id: string) => boolean = always): string[] {
  const keep = rank(group, rule, isProtected, present)[0]
  return group.ids.filter((id, i) => i !== keep && present(id) && !isProtected(id))
}

/**
 * Would selecting `id` leave nothing of its group? True when every other copy still in the library
 * is selected already (a group with one file left doesn't count: that file is no longer a copy).
 */
export function isLastCopy(group: DupGroup, id: string, marks: Set<string>, present: (id: string) => boolean = always) {
  const live = group.ids.filter(present)
  return live.length > 1 && live.includes(id) && live.every((x) => x === id || marks.has(x))
}

/**
 * The files of duplicate groups the keep rule hasn't decided on yet. `seen` holds every file it has
 * decided on; the new ones are added to it here.
 */
export function newFiles(groups: DupGroup[], present: (id: string) => boolean, seen: Set<string>) {
  const fresh = new Set<string>()
  for (const g of groups) {
    for (const id of g.ids) {
      if (!present(id) || seen.has(id)) continue
      seen.add(id)
      fresh.add(id)
    }
  }
  return fresh
}

/**
 * The keep rule for new files only (DupeLens selects by the rule after a scan): files it decided on
 * before keep whatever the user chose since, and a group is never left with every copy selected.
 * Returns the marks to add and remove.
 */
export function ruleNewFiles(groups: DupGroup[], rule: KeepRule, isProtected: (id: string) => boolean, present: (id: string) => boolean, fresh: Set<string>, marks: Set<string>) {
  const add = new Set<string>()
  const remove = new Set<string>()
  for (const g of groups) {
    if (!g.ids.some((id) => fresh.has(id))) continue
    const ruled = new Set(ruleMarks(g, rule, isProtected, present))
    for (const id of g.ids) if (fresh.has(id) && ruled.has(id)) add.add(id)
    const live = g.ids.filter(present)
    if (live.length > 1 && live.every((id) => (marks.has(id) || add.has(id)) && !remove.has(id))) {
      const keep = g.ids[rank(g, rule, isProtected, present)[0]]
      add.delete(keep)
      remove.add(keep)
    }
  }
  return { add: [...add], remove: [...remove] }
}

/** Identifies a group by its members (in any order). */
export const groupKey = (g: DupGroup) => [...g.ids].sort().join('|')

// ---------- group texts ----------

export const kindText = (g: DupGroup) => (g.exact ? 'Exact copies' : `${Math.round(g.min * 100)}% similar`)
/** Loose matches are often burst shots or re-photographed prints rather than true copies. */
export const needsReview = (g: DupGroup) => !g.exact && g.min < 0.95

export function matchText(g: DupGroup, i: number) {
  const info = g.info[i]
  if (info[0] === 'best') return 'Best copy'
  if (info[0] === 'identical') return 'Identical copy'
  if (typeof info[0] !== 'number') return ''
  const kind =
    info[1] === 'rotated'
      ? ' · rotated'
      : info[1] === 'mirrored'
        ? ' · mirrored'
        : info[1] === 'cropped'
          ? ' · cropped'
          : info[1] === 'trimmed'
            ? ' · trimmed clip'
            : info[1] === 'longer'
              ? ' · longer version'
              : ''
  return `${Math.round(info[0] * 100)}% match${kind}`
}

// ---------- the other finders ----------

const SCREENSHOT = /(screen\s?shot|screen_shot|screenshot|screen\s?recording|screenrecord)/i
export const isScreenshot = (it: MediaItem) => SCREENSHOT.test(it.name) || it.dir.split(/[\\/]/).some((p) => p.toLowerCase() === 'screenshots')
const COPY_NAME = /(-WA\d+|\bcopy\b|\(\d+\)|^Screenshot|WhatsApp)/i
export const looksLikeCopy = (it: MediaItem) => COPY_NAME.test(it.name.replace(/\.[^.]+$/, ''))
const WHATSAPP = /(-WA\d+|WhatsApp)/i
export const isWhatsApp = (it: MediaItem) => WHATSAPP.test(it.name) || /whatsapp/i.test(it.dir)

export const DARK = 28
export const BRIGHT = 248
export const MAX_LISTED = 2000

/** [sharpness, brightness, blank (0/1), width, height] per analysed item. */
export type Facts = Record<string, [number, number, number, number, number]>

export function lowQualityReason(it: MediaItem, facts: Facts, blurThreshold: number) {
  const f = facts[it.id]
  if (it.type !== 'image' || !f || f[0] < 0) return null
  if (f[2]) return 'Almost blank'
  if (f[1] < DARK) return 'Very dark'
  if (f[1] > BRIGHT) return 'Washed out'
  if (f[0] < blurThreshold && !isScreenshot(it)) return 'Blurry'
  return null
}

export interface Listed {
  item: MediaItem
  issue: string
}

export function lowQualityList(items: MediaItem[], facts: Facts, blurThreshold: number): Listed[] {
  const out: Listed[] = []
  for (const it of items) {
    const reason = lowQualityReason(it, facts, blurThreshold)
    if (reason) out.push({ item: it, issue: reason === 'Blurry' ? `Blurry · sharpness ${Math.round(facts[it.id][0])}` : reason })
  }
  return out.sort((a, b) => (facts[a.item.id]?.[0] ?? 0) - (facts[b.item.id]?.[0] ?? 0)).slice(0, MAX_LISTED)
}

export const screenshotList = (items: MediaItem[]): Listed[] =>
  items
    .filter(isScreenshot)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_LISTED)
    .map((item) => ({ item, issue: item.type === 'video' ? 'Screen recording' : 'Screenshot' }))

export const largeList = (items: MediaItem[], minBytes: number): Listed[] =>
  items
    .filter((it) => it.size >= minBytes)
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_LISTED)
    .map((item) => ({ item, issue: formatBytes(item.size) }))

// ---------- folders ----------

export interface FolderPair {
  a: string
  b: string
  countA: number
  countB: number
  matchedA: number
  matchedB: number
  bytesA: number
  bytesB: number
}

/** Folders where ≥ 90 % of one folder's files have a copy in the other (and ≥ 3 each way). */
export function duplicateFolders(items: MediaItem[], groups: DupGroup[], byId: Map<string, MediaItem>): FolderPair[] {
  const count = new Map<string, number>()
  for (const it of items) count.set(it.dir, (count.get(it.dir) ?? 0) + 1)
  const matched = new Map<string, { n: number; bytes: number }>()
  for (const g of groups) {
    const byDir = new Map<string, MediaItem[]>()
    for (const id of g.ids) {
      const it = byId.get(id)
      if (!it) continue
      if (!byDir.has(it.dir)) byDir.set(it.dir, [])
      byDir.get(it.dir)!.push(it)
    }
    if (byDir.size < 2) continue
    for (const [a, inA] of byDir)
      for (const b of byDir.keys()) {
        if (a === b) continue
        const key = `${a}\n${b}`
        const m = matched.get(key) ?? { n: 0, bytes: 0 }
        m.n += inA.length
        m.bytes += inA.reduce((s, it) => s + it.size, 0)
        matched.set(key, m)
      }
  }
  const pairs: FolderPair[] = []
  for (const [key, mA] of matched) {
    const [a, b] = key.split('\n')
    if (a > b) continue
    const mB = matched.get(`${b}\n${a}`)
    if (!mB) continue
    const countA = count.get(a) ?? 0
    const countB = count.get(b) ?? 0
    if (!countA || !countB) continue
    const ratio = Math.max(Math.min(1, mA.n / countA), Math.min(1, mB.n / countB))
    if (ratio >= 0.9 && Math.min(mA.n, mB.n) >= 3) {
      pairs.push({ a, b, countA, countB, matchedA: Math.min(mA.n, countA), matchedB: Math.min(mB.n, countB), bytesA: mA.bytes, bytesB: mB.bytes })
    }
  }
  return pairs.sort((x, y) => y.bytesA + y.bytesB - (x.bytesA + x.bytesB))
}

export function folderPairSummary(p: FolderPair) {
  const na = baseName(p.a)
  const nb = baseName(p.b)
  if (p.matchedA >= p.countA && p.matchedB >= p.countB) return `Same ${formatCount(p.countA)} files in both folders`
  if (p.matchedA >= p.countA) return `Everything in “${na}” (${formatCount(p.countA)}) is also in “${nb}”`
  if (p.matchedB >= p.countB) return `Everything in “${nb}” (${formatCount(p.countB)}) is also in “${na}”`
  return `${formatCount(p.matchedA)} of ${formatCount(p.countA)} files in “${na}” are also in “${nb}”`
}
export const folderPairPercent = (p: FolderPair) => Math.round(100 * Math.max(p.matchedA / p.countA, p.matchedB / p.countB))

export interface BackupCheck {
  both: MediaItem[]
  missing: MediaItem[]
  onlyBackup: MediaItem[]
}

/** Is everything in `main` also in `backup` (as an exact or look-alike copy)? */
export function backupCheck(items: MediaItem[], main: string, backup: string, groupOf: Map<string, DupGroup>, byId: Map<string, MediaItem>): BackupCheck {
  const res: BackupCheck = { both: [], missing: [], onlyBackup: [] }
  for (const it of items) {
    const inMain = isUnder(it.path, main)
    const inBackup = isUnder(it.path, backup)
    if (inMain === inBackup) continue
    const copies = (groupOf.get(it.id)?.ids ?? []).map((id) => byId.get(id)).filter((x): x is MediaItem => !!x && x.id !== it.id)
    if (inMain) (copies.some((c) => isUnder(c.path, backup)) ? res.both : res.missing).push(it)
    else if (!copies.some((c) => isUnder(c.path, main))) res.onlyBackup.push(it)
  }
  return res
}

// ---------- reports ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const csvCell = (v: string | number) => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export interface ReportInput {
  summary: string
  groups: DupGroup[]
  byId: Map<string, MediaItem>
  facts: Facts
  marks: Set<string>
  isProtected: (id: string) => boolean
  lists: [string, Listed[]][]
}

export function buildReports(r: ReportInput) {
  const rows: (string | number)[][] = [['Group', 'Kind', 'Action', 'Match', 'File', 'Folder', 'Resolution', 'Size (bytes)', 'Date taken', 'Modified', 'Issue']]
  const action = (id: string) => (r.isProtected(id) ? 'Protected' : r.marks.has(id) ? 'Remove' : 'Keep')
  const res = (id: string) => {
    const f = r.facts[id]
    return f && f[3] ? `${f[3]} × ${f[4]}` : ''
  }
  const date = (ms?: number | null) => (ms ? new Date(ms).toLocaleString() : '')
  let extra = 0
  let selected = 0
  let free = 0
  const cards: string[] = []
  for (const g of r.groups) {
    extra += g.ids.length - 1
    const trs: string[] = []
    g.ids.forEach((id, i) => {
      const it = r.byId.get(id)
      if (!it) return
      const a = action(id)
      if (a === 'Remove') {
        selected++
        free += it.size
      }
      rows.push([g.n, kindText(g), a, matchText(g, i), it.name, it.dir, res(id), it.size, date(it.taken), date(it.mtime), ''])
      trs.push(
        `<tr><td class="${a === 'Remove' ? 'rm' : 'keep'}">${a}</td><td>${esc(it.name)}</td><td>${res(id)}</td><td>${formatBytes(it.size)}</td><td>${esc(matchText(g, i))}</td><td class="dir">${esc(it.dir)}</td></tr>`,
      )
    })
    cards.push(`<section><h2>Group ${g.n}${g.video ? ' · videos' : ''} <span class="pill">${esc(kindText(g))}</span></h2><table><tr><th>Action</th><th>File</th><th>Resolution</th><th>Size</th><th>Match</th><th>Folder</th></tr>${trs.join('')}</table></section>`)
  }
  for (const [name, list] of r.lists) {
    const trs: string[] = []
    for (const { item, issue } of list) {
      rows.push(['', name, r.marks.has(item.id) ? 'Remove' : '', '', item.name, item.dir, res(item.id), item.size, date(item.taken), date(item.mtime), issue])
      trs.push(`<tr><td>${esc(item.name)}</td><td>${esc(issue)}</td><td>${formatBytes(item.size)}</td><td class="dir">${esc(item.dir)}</td></tr>`)
    }
    if (list.length)
      cards.push(`<section><h2>${esc(name)} <span class="pill">${formatCount(list.length)} files</span></h2><table><tr><th>File</th><th>Why</th><th>Size</th><th>Folder</th></tr>${trs.join('')}</table></section>`)
  }
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lumen report</title><style>
:root{--bg:#f3f4f7;--card:#fff;--text:#13161b;--muted:#586172;--line:#e3e6eb;--red:#dc3d43;--green:#16935a;--accent:#4a67ea}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#191c22;--text:#edf0f5;--muted:#9ba3b3;--line:#242831;--red:#ef5a60;--green:#3fd58e;--accent:#6f8cff}}
body{margin:0;padding:32px 16px;background:var(--bg);color:var(--text);font:14px/1.45 "Segoe UI",system-ui,sans-serif}main{max-width:1100px;margin:auto}
h1{margin:0 0 4px;font-size:26px}.sub{color:var(--muted);margin:0 0 20px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.stat b{display:block;font-size:22px}.stat span{color:var(--muted)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px;overflow-x:auto}h2{font-size:15px;margin:0 0 10px}
.pill{font-size:12px;font-weight:600;padding:2px 8px;border-radius:10px;background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent);margin-left:6px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:5px 8px;border-top:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.rm{color:var(--red);font-weight:600}.keep{color:var(--green);font-weight:600}.dir{color:var(--muted);word-break:break-all}</style></head><body><main>
<h1>Lumen report</h1><p class="sub">${esc(r.summary)} · generated ${new Date().toLocaleString()}</p>
<div class="stats"><div class="stat"><b>${formatCount(r.groups.length)}</b><span>Duplicate groups</span></div><div class="stat"><b>${formatCount(extra)}</b><span>Extra copies</span></div><div class="stat"><b>${formatCount(selected)}</b><span>Selected to remove</span></div><div class="stat"><b>${formatBytes(free)}</b><span>Space to free</span></div></div>
${cards.join('\n')}</main></body></html>`
  return { html, csv }
}
