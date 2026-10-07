import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Columns2,
  Download,
  ExternalLink,
  Folder,
  FolderInput,
  FolderOpen,
  LoaderCircle,
  Maximize2,
  RefreshCcw,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash,
  Undo2,
} from 'lucide-react'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api'
import {
  backupCheck,
  duplicateFolders,
  folderPairPercent,
  folderPairSummary,
  isUnder,
  isWhatsApp,
  KEEP_RULES,
  kindText,
  largeList,
  lowQualityList,
  matchText,
  needsReview,
  rank,
  ruleMarks,
  screenshotList,
  type Facts,
  type Listed,
} from '../lib/cleanup'
import { baseName, formatBytes, formatCount, formatDuration } from '../lib/format'
import { fold } from '../lib/search'
import type { DupGroup, DuplicatesData, DuplicatesProgress, KeepRule, MediaItem, Settings } from '../types'
import { CoverImage } from './CoverImage'
import { InsightsView } from './InsightsView'
import { EmptyState } from './Overlays'
import { PopoverMenu } from './PopoverMenu'

export type CleanupTab = 'duplicates' | 'quality' | 'screenshots' | 'large' | 'folders' | 'backup' | 'insights'
type Filter = 'all' | 'exact' | 'similar'
type GroupSort = 'found' | 'space' | 'copies' | 'newest' | 'name'
type ListSort = 'suggested' | 'largest' | 'newest' | 'oldest' | 'name' | 'folder'

const PAGE = 30
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export interface CleanupActions {
  setMarks(update: (prev: Set<string>) => Set<string>): void
  /** Opens compare/review on these groups, starting at `index` (optionally focusing one file). */
  onCompare(groups: DupGroup[], index: number, focus?: string): void
  /** Single-file preview over a flat list. */
  onPreview(list: MediaItem[], index: number): void
  onMove(ids: string[]): void
  onRecycle(ids: string[]): void
  onUndo(): void
  onProtectFolder(dir: string): void
  onExport(): void
  onToast(text: string): void
  /** "These aren't duplicates": hide the group for good. */
  onDismiss(ids: string[]): void
}

interface Props extends CleanupActions {
  tab: CleanupTab
  onTab(tab: CleanupTab): void
  data: DuplicatesData
  progress: DuplicatesProgress
  waiting: boolean
  items: MediaItem[]
  byId: Map<string, MediaItem>
  marks: Set<string>
  settings: Settings
  isProtected(id: string): boolean
  query: string
  canUndo: boolean
}

const itemMatches = (it: MediaItem, terms: string[]) =>
  terms.every((t) => {
    const camera = fold(`${it.meta?.make ?? ''} ${it.meta?.model ?? ''}`)
    return fold(it.name).includes(t) || fold(it.dir).includes(t) || camera.includes(t) || (t.length === 4 && String(new Date(it.date).getFullYear()) === t)
  })

export function CleanupView(props: Props) {
  const { data, items, byId, marks, settings, isProtected, tab } = props
  const facts = data.facts as Facts
  const [filter, setFilter] = useState<Filter>('all')
  const [groupSort, setGroupSort] = useState<GroupSort>('found')
  const [listSort, setListSort] = useState<ListSort>('suggested')
  const [limit, setLimit] = useState(PAGE)
  const [backupView, setBackupView] = useState<'both' | 'missing' | 'only'>('missing')
  const roots = settings.folders
  const [main, setMain] = useState(roots[0] ?? '')
  const [backup, setBackup] = useState(roots[1] ?? '')
  useEffect(() => setLimit(PAGE), [tab, filter, groupSort, props.query])

  const terms = useMemo(() => fold(props.query).split(/\s+/).filter(Boolean), [props.query])
  const rule = settings.keepRule

  // groups whose files still exist
  const groups = useMemo(
    () => data.groups.filter((g) => g.ids.filter((id) => byId.has(id)).length > 1),
    [data.groups, byId],
  )
  const groupOf = useMemo(() => {
    const m = new Map<string, DupGroup>()
    for (const g of groups) for (const id of g.ids) m.set(id, g)
    return m
  }, [groups])
  const counts = useMemo(() => ({ all: groups.length, exact: groups.filter((g) => g.exact).length, similar: groups.filter((g) => !g.exact).length }), [groups])

  const extraBytes = (g: DupGroup) => g.ids.reduce((s, id, i) => (i === g.ref ? s : s + (byId.get(id)?.size ?? 0)), 0)
  const visibleGroups = useMemo(() => {
    let list = groups.filter((g) => (filter === 'all' ? true : filter === 'exact' ? g.exact : !g.exact))
    if (terms.length) list = list.filter((g) => g.ids.some((id) => { const it = byId.get(id); return !!it && itemMatches(it, terms) }))
    const newest = (g: DupGroup) => Math.max(...g.ids.map((id) => byId.get(id)?.date ?? 0))
    const first = (g: DupGroup) => g.ids.map((id) => byId.get(id)?.name.toLowerCase() ?? '').sort()[0]
    const cmp: Record<GroupSort, (a: DupGroup, b: DupGroup) => number> = {
      found: () => 0,
      space: (a, b) => extraBytes(b) - extraBytes(a),
      copies: (a, b) => b.ids.length - a.ids.length || extraBytes(b) - extraBytes(a),
      newest: (a, b) => newest(b) - newest(a),
      name: (a, b) => first(a).localeCompare(first(b)),
    }
    return [...list].sort((a, b) => cmp[groupSort](a, b) || a.n - b.n)
  }, [groups, filter, terms, groupSort, byId])

  // ---------- the flat lists ----------
  const lists = useMemo(() => {
    const quality = lowQualityList(items, facts, settings.blurThreshold)
    const shots = screenshotList(items)
    const large = largeList(items, settings.largeFileMB * 1024 * 1024)
    return { quality, shots, large }
  }, [items, facts, settings.blurThreshold, settings.largeFileMB])
  const pairs = useMemo(() => duplicateFolders(items, groups, byId), [items, groups, byId])
  const backupRes = useMemo(
    () => (main && backup && main !== backup ? backupCheck(items, main, backup, groupOf, byId) : null),
    [items, main, backup, groupOf, byId],
  )

  const flat: Listed[] | null =
    tab === 'quality'
      ? lists.quality
      : tab === 'screenshots'
        ? lists.shots
        : tab === 'large'
          ? lists.large
          : tab === 'backup' && backupRes
            ? (backupView === 'both' ? backupRes.both : backupView === 'missing' ? backupRes.missing : backupRes.onlyBackup).map((item) => ({ item, issue: '' }))
            : null
  const visibleFlat = useMemo(() => {
    if (!flat) return []
    let list = terms.length ? flat.filter((l) => itemMatches(l.item, terms)) : flat
    const by: Record<ListSort, ((a: Listed, b: Listed) => number) | null> = {
      suggested: null,
      largest: (a, b) => b.item.size - a.item.size,
      newest: (a, b) => b.item.date - a.item.date,
      oldest: (a, b) => a.item.date - b.item.date,
      name: (a, b) => a.item.name.localeCompare(b.item.name),
      folder: (a, b) => a.item.dir.localeCompare(b.item.dir) || a.item.name.localeCompare(b.item.name),
    }
    const c = by[listSort]
    if (c) list = [...list].sort(c)
    return list
  }, [flat, terms, listSort])

  // ---------- selection in the current tab ----------
  const tabIds = useMemo(() => {
    if (tab === 'duplicates') return groups.flatMap((g) => g.ids)
    if (tab === 'folders') {
      const dirs = new Set(pairs.flatMap((p) => [p.a, p.b]))
      return groups.flatMap((g) => g.ids).filter((id) => dirs.has(byId.get(id)?.dir ?? ''))
    }
    return (flat ?? []).map((l) => l.item.id)
  }, [tab, groups, pairs, flat, byId])
  const marked = tabIds.filter((id) => marks.has(id) && byId.has(id))
  const markedBytes = marked.reduce((s, id) => s + (byId.get(id)?.size ?? 0), 0)

  const mark = (ids: string[], value: boolean) =>
    props.setMarks((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (value && isProtected(id)) continue
        if (value) next.add(id)
        else next.delete(id)
      }
      return next
    })
  const toggle = (id: string) => {
    if (isProtected(id)) return props.onToast('Files in protected folders are always kept')
    mark([id], !marks.has(id))
  }
  const applyRule = (gs: DupGroup[], r: KeepRule = rule) =>
    props.setMarks((prev) => {
      const next = new Set(prev)
      for (const g of gs) {
        for (const id of g.ids) next.delete(id)
        for (const id of ruleMarks(g, r, isProtected)) next.add(id)
      }
      return next
    })
  const keepOnly = (g: DupGroup, keep: string) =>
    props.setMarks((prev) => {
      const next = new Set(prev)
      for (const id of g.ids) if (id !== keep && !isProtected(id)) next.add(id)
      next.delete(keep)
      return next
    })

  /** Adds to the selection, worst copies first, always leaving at least one copy per group. */
  const addWhere = (test: (it: MediaItem, g: DupGroup, i: number) => boolean) => {
    let added = 0
    const next = new Set(marks)
    for (const g of groups) {
      let kept = g.ids.filter((id) => !next.has(id)).length
      for (const i of [...rank(g, rule, isProtected)].reverse()) {
        const id = g.ids[i]
        const it = byId.get(id)
        if (!it || isProtected(id) || next.has(id) || !test(it, g, i)) continue
        if (kept <= 1) break
        next.add(id)
        kept--
        added++
      }
    }
    props.setMarks(() => next)
    props.onToast(added ? `Selected ${formatCount(added)} more files` : 'Nothing new to select')
  }
  const pixels = (id: string) => (facts[id] ? facts[id][3] * facts[id][4] : 0)
  const topFolders = useMemo(() => {
    const count = new Map<string, number>()
    for (const g of groups) for (const id of g.ids) {
      const dir = byId.get(id)?.dir
      if (dir) count.set(dir, (count.get(dir) ?? 0) + 1)
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  }, [groups, byId])

  // ---------- stats ----------
  const extraCopies = groups.reduce((s, g) => s + g.ids.length - 1, 0)
  const stats: [string, string][] =
    tab === 'duplicates'
      ? [['Duplicate groups', formatCount(groups.length)], ['Extra copies found', formatCount(extraCopies)]]
      : tab === 'folders'
        ? [['Duplicate folders', formatCount(pairs.length)], ['Space in copied folders', formatBytes(pairs.reduce((s, p) => s + Math.min(p.bytesA, p.bytesB), 0))]]
        : tab === 'backup'
          ? [['Already backed up', formatCount(backupRes?.both.length ?? 0)], ['Missing from backup', formatCount(backupRes?.missing.length ?? 0)]]
          : tab === 'insights'
            ? [['Files scanned', formatCount(items.length)], ['Total size', formatBytes(items.reduce((s, it) => s + it.size, 0))]]
            : [['Files found', formatCount(flat?.length ?? 0)], ['Total size', formatBytes((flat ?? []).reduce((s, l) => s + l.item.size, 0))]]

  const tabs: [CleanupTab, string, number | null][] = [
    ['duplicates', 'Duplicates', groups.length],
    ['quality', 'Blurry & dark', lists.quality.length],
    ['screenshots', 'Screenshots', lists.shots.length],
    ['large', 'Large files', lists.large.length],
    ...(pairs.length ? ([['folders', 'Duplicate folders', pairs.length]] as [CleanupTab, string, number][]) : []),
    ...(roots.length >= 2 ? ([['backup', 'Backup check', null]] as [CleanupTab, string, null][]) : []),
    ['insights', 'Insights', null],
  ]

  const status =
    props.progress.running && props.progress.total
      ? `${props.progress.phase === 'hashing' ? 'Comparing file contents' : 'Reading photos'} · ${Math.floor((props.progress.done / props.progress.total) * 100)}%`
      : props.progress.running
        ? 'Comparing photos…'
        : null

  const actions = (
    <div className="clean-actions">
      {props.canUndo && (
        <button className="btn ghost" onClick={props.onUndo} title="Undo the last move (Ctrl+Z)">
          <Undo2 size={15} /> Undo
        </button>
      )}
      <button
        className="btn ghost"
        disabled={tab === 'duplicates' ? !visibleGroups.length : !visibleFlat.length}
        onClick={() => (tab === 'duplicates' ? props.onCompare(visibleGroups, 0) : props.onPreview(visibleFlat.map((l) => l.item), 0))}
        title="Review one by one (Ctrl+R)"
      >
        <Columns2 size={15} /> Review
      </button>
      <button className="btn ghost" disabled={!marked.length} onClick={() => props.onMove(marked)} title={`Move to ${settings.moveDestination ?? settings.defaultMoveDestination}`}>
        <FolderInput size={15} /> {marked.length ? `Move ${formatCount(marked.length)} to folder` : 'Move to folder'}
      </button>
      <button className="btn danger" disabled={!marked.length} onClick={() => props.onRecycle(marked)}>
        <Trash size={15} /> Recycle
      </button>
    </div>
  )

  let body: ReactNode
  if (tab === 'insights') {
    body = (
      <div className="clean-pad">
      <InsightsView
        items={items}
        groups={data.groups}
        facts={facts}
        roots={roots}
        blurThreshold={settings.blurThreshold}
        largeFileMB={settings.largeFileMB}
        onReview={props.onTab}
      />
      </div>
    )
  } else if (tab === 'duplicates') {
    body = !groups.length ? (
      status || props.waiting ? (
        <EmptyState
          icon={<LoaderCircle size={40} className="spin" />}
          title="Looking for duplicates…"
          text={props.waiting ? 'This starts as soon as every preview is ready.' : `${status}. You can keep using Lumen meanwhile.`}
        />
      ) : (
        <EmptyState icon={<Check size={44} strokeWidth={1.5} />} title="No duplicates found" text="Every photo and video in your library is one of a kind." />
      )
    ) : !visibleGroups.length ? (
      <EmptyState icon={<Sparkles size={40} strokeWidth={1.5} />} title="Nothing matches your search" text='Try part of a file name, a folder, a camera like "iPhone", or a year like 2019.' />
    ) : (
      <div className="clean-groups">
        {visibleGroups.slice(0, limit).map((g, gi) => (
          <GroupCard
            key={g.n + ':' + g.ids[0]}
            group={g}
            byId={byId}
            facts={facts}
            marks={marks}
            isProtected={isProtected}
            onToggle={toggle}
            onKeepOnly={(id) => keepOnly(g, id)}
            onAuto={() => applyRule([g])}
            onCompare={(focus) => props.onCompare(visibleGroups, gi, focus)}
            onProtectFolder={props.onProtectFolder}
            onDismiss={() => props.onDismiss(g.ids)}
          />
        ))}
        {visibleGroups.length > limit && (
          <button className="btn ghost clean-more" onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({formatCount(visibleGroups.length - limit)} groups left)
          </button>
        )}
      </div>
    )
  } else if (tab === 'folders') {
    body = pairs.length ? (
      <div className="clean-groups">
        {pairs.map((p) => (
          <section key={p.a + p.b} className="clean-group">
            <div className="clean-group-head">
              <span className="kind-pill">{folderPairPercent(p)}% overlap</span>
              <span className="clean-group-title">{folderPairSummary(p)}</span>
            </div>
            <div className="folder-pair">
              {([
                [p.a, p.b, p.matchedA, p.countA, p.bytesA],
                [p.b, p.a, p.matchedB, p.countB, p.bytesB],
              ] as const).map(([dir, other, m, c, bytes], k) => (
                <div key={dir} className="folder-box">
                  {k === 1 && <ArrowLeftRight size={18} className="folder-pair-arrow" />}
                  <div className="folder-box-name">
                    <Folder size={16} /> {baseName(dir)}
                  </div>
                  <div className="folder-box-path" title={dir}>
                    {dir}
                  </div>
                  <div className="folder-box-meta">
                    {formatCount(m)} of {formatCount(c)} files have copies · {formatBytes(bytes)}
                  </div>
                  <div className="folder-box-actions">
                    <button className="btn ghost" onClick={() => selectFolderCopies(dir, other)}>
                      Select copies here
                    </button>
                    <button className="icon-btn" onClick={() => api.revealFolder(dir)} title="Open folder">
                      <FolderOpen size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    ) : (
      <EmptyState icon={<Folder size={44} strokeWidth={1.5} />} title="No duplicate folders" text="No two folders share 90% or more of their photos." />
    )
  } else {
    body = (
      <>
        {tab === 'backup' && (
          <div className="backup-bar">
            <span>Is everything in</span>
            <select value={main} onChange={(e) => (e.target.value === backup ? (setBackup(main), setMain(e.target.value)) : setMain(e.target.value))}>
              {roots.map((r) => (
                <option key={r} value={r}>
                  {baseName(r)}
                </option>
              ))}
            </select>
            <span>backed up in</span>
            <select value={backup} onChange={(e) => (e.target.value === main ? (setMain(backup), setBackup(e.target.value)) : setBackup(e.target.value))}>
              {roots.map((r) => (
                <option key={r} value={r}>
                  {baseName(r)}
                </option>
              ))}
            </select>
            <button className="icon-btn" title="Swap" onClick={() => (setMain(backup), setBackup(main))}>
              <ArrowLeftRight size={16} />
            </button>
            <div className="segmented small">
              {([
                ['both', 'Backed up', backupRes?.both.length ?? 0],
                ['missing', 'Missing from backup', backupRes?.missing.length ?? 0],
                ['only', 'Only in backup', backupRes?.onlyBackup.length ?? 0],
              ] as const).map(([k, label, n]) => (
                <button key={k} className={backupView === k ? 'active' : ''} onClick={() => setBackupView(k)}>
                  {label} <span className="chip-count">{formatCount(n)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {visibleFlat.length ? (
          <div className="clean-flat">
            {visibleFlat.slice(0, limit * 4).map((l, i) => (
              <Tile
                key={l.item.id}
                item={l.item}
                facts={facts}
                marked={marks.has(l.item.id)}
                protectedFile={isProtected(l.item.id)}
                showBadge={marks.has(l.item.id)}
                match={l.issue}
                onToggle={() => toggle(l.item.id)}
                onOpen={() => props.onPreview(visibleFlat.map((x) => x.item), i)}
                onProtectFolder={props.onProtectFolder}
              />
            ))}
            {visibleFlat.length > limit * 4 && (
              <button className="btn ghost clean-more" onClick={() => setLimit((l) => l + PAGE)}>
                Show more ({formatCount(visibleFlat.length - limit * 4)} left)
              </button>
            )}
          </div>
        ) : (
          <EmptyState
            icon={<Check size={44} strokeWidth={1.5} />}
            title={EMPTY[tab][0]}
            text={tab === 'quality' && !Object.keys(facts).length ? 'Photos are checked once their previews are ready.' : EMPTY[tab][1]}
          />
        )}
      </>
    )
  }

  function selectFolderCopies(dir: string, other: string) {
    let added = 0
    const next = new Set(marks)
    for (const g of groups) {
      const members = g.ids.map((id) => byId.get(id)).filter((x): x is MediaItem => !!x)
      if (!members.some((it) => it.dir === other && !next.has(it.id))) continue
      for (const it of members) {
        if (it.dir !== dir || next.has(it.id) || isProtected(it.id)) continue
        next.add(it.id)
        added++
      }
      // never every copy: keep the rule's pick if everything got selected
      if (g.ids.every((id) => next.has(id) || !byId.has(id))) next.delete(g.ids[rank(g, rule, isProtected)[0]])
    }
    props.setMarks(() => next)
    props.onToast(added ? `Selected ${formatCount(added)} files in “${baseName(dir)}” that also exist in “${baseName(other)}”` : 'Nothing new to select in that folder')
  }

  return (
    <div className="clean-scroll">
      <div className="clean-stats">
        {stats.map(([label, value]) => (
          <div key={label} className="clean-stat">
            <b>{value}</b>
            <span>{label}</span>
          </div>
        ))}
        <div className="clean-stat danger">
          <b>{formatCount(marked.length)}</b>
          <span>Selected to remove</span>
        </div>
        <div className="clean-stat success">
          <b>{formatBytes(markedBytes)}</b>
          <span>Space you'll free</span>
        </div>
      </div>

      <div className="clean-tabs">
        {tabs.map(([key, label, n]) => (
          <button key={key} className={`clean-tab${tab === key ? ' active' : ''}`} onClick={() => props.onTab(key)}>
            {label}
            {n !== null && <span className="chip-count">{formatCount(n)}</span>}
          </button>
        ))}
        <div className="spacer" />
        {status && (
          <span className="clean-status">
            <LoaderCircle size={13} className="spin" /> {status}
          </span>
        )}
        <button className="btn ghost" onClick={props.onExport} title="Export a report (HTML or CSV)">
          <Download size={15} /> Export
        </button>
      </div>

      <div className="clean-toolbar" hidden={tab === 'insights'}>
        {tab === 'duplicates' ? (
          <>
            <div className="segmented small">
              {(['all', 'exact', 'similar'] as Filter[]).map((f) => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'exact' ? 'Exact' : 'Similar'} <span className="chip-count">{formatCount(counts[f])}</span>
                </button>
              ))}
            </div>
            <label className="clean-select" title="Which copy to keep when selecting automatically">
              Keep
              <select
                value={rule}
                onChange={(e) => {
                  const r = e.target.value as KeepRule
                  api.setSettings({ keepRule: r })
                  applyRule(groups, r)
                }}
              >
                {KEEP_RULES.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button className="icon-btn" title="Select again by this rule (in every group)" onClick={() => applyRule(groups)}>
              <RefreshCcw size={15} />
            </button>
            <PopoverMenu
              items={[
                { label: 'All WhatsApp copies', onClick: () => addWhere((it) => isWhatsApp(it)) },
                {
                  label: 'All lower-resolution copies',
                  onClick: () => addWhere((it, g) => pixels(it.id) > 0 && pixels(it.id) < Math.max(...g.ids.map(pixels))),
                },
                {
                  label: 'Exact copies only (skip similar)',
                  onClick: () => {
                    applyRule(groups.filter((g) => g.exact))
                    mark(groups.filter((g) => !g.exact).flatMap((g) => g.ids), false)
                  },
                },
                ...topFolders.map(([dir, n]) => ({
                  label: `Everything in “${baseName(dir)}” (${formatCount(n)})`,
                  icon: <Folder size={15} />,
                  onClick: () => addWhere((it) => it.dir === dir),
                })),
              ]}
              trigger={(open, t) => (
                <button className={`btn ghost${open ? ' on' : ''}`} onClick={t} title="Add to the selection (at least one copy in every group is always kept)">
                  Select <ChevronDown size={14} />
                </button>
              )}
            />
            <button className="btn ghost" disabled={!marked.length} onClick={() => mark(tabIds, false)}>
              Clear
            </button>
            <label className="clean-select" title="Group order">
              Sort
              <select value={groupSort} onChange={(e) => setGroupSort(e.target.value as GroupSort)}>
                <option value="found">Found order</option>
                <option value="space">Most space to free</option>
                <option value="copies">Most copies</option>
                <option value="newest">Newest first</option>
                <option value="name">Name</option>
              </select>
            </label>
            <span className="clean-count">
              {terms.length || filter !== 'all' ? `${formatCount(visibleGroups.length)} of ${formatCount(groups.length)} groups` : ''}
            </span>
          </>
        ) : tab === 'folders' ? (
          <span className="clean-hint">Folders where at least 90% of the photos also exist in another folder.</span>
        ) : (
          <>
            <span className="clean-hint">{HINT[tab]}</span>
            <button className="btn ghost" disabled={!visibleFlat.length} onClick={() => mark(visibleFlat.map((l) => l.item.id), true)}>
              Select all
            </button>
            <button className="btn ghost" disabled={!marked.length} onClick={() => mark(tabIds, false)}>
              Clear
            </button>
            <label className="clean-select">
              Sort
              <select value={listSort} onChange={(e) => setListSort(e.target.value as ListSort)}>
                <option value="suggested">Suggested order</option>
                <option value="largest">Largest first</option>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name</option>
                <option value="folder">Folder</option>
              </select>
            </label>
          </>
        )}
        <div className="spacer" />
        {actions}
      </div>
      {body}
    </div>
  )
}

const HINT: Record<string, string> = {
  quality: 'Blurry, very dark, washed-out and almost blank photos.',
  screenshots: 'Screenshots and screen recordings.',
  large: 'The biggest files in your library.',
  backup: '',
}
const EMPTY: Record<string, [string, string]> = {
  quality: ['No blurry or dark photos', 'Every photo looks sharp and well exposed.'],
  screenshots: ['No screenshots', 'No screenshots or screen recordings were found.'],
  large: ['No large files', 'No file is over the size set in Settings.'],
  backup: ['Nothing here', 'Pick two different folders.'],
  folders: ['', ''],
  duplicates: ['', ''],
}

// ---------- group card & tile ----------

function GroupCard({
  group: g,
  byId,
  facts,
  marks,
  isProtected,
  onToggle,
  onKeepOnly,
  onAuto,
  onCompare,
  onProtectFolder,
  onDismiss,
}: {
  group: DupGroup
  byId: Map<string, MediaItem>
  facts: Facts
  marks: Set<string>
  isProtected(id: string): boolean
  onToggle(id: string): void
  onKeepOnly(id: string): void
  onAuto(): void
  onCompare(focus?: string): void
  onProtectFolder(dir: string): void
  onDismiss(): void
}) {
  const live = g.ids.map((id, i) => [id, i] as const).filter(([id]) => byId.has(id))
  const nMarked = live.filter(([id]) => marks.has(id)).length
  const bytes = live.reduce((s, [id]) => (marks.has(id) ? s + byId.get(id)!.size : s), 0)
  const all = nMarked === live.length
  return (
    <section className="clean-group">
      <div className="clean-group-head">
        <span
          className={`kind-pill${g.exact ? ' exact' : needsReview(g) ? ' review' : ''}`}
          title={needsReview(g) ? 'Lower similarity: these may be separate shots of the same scene. Check before removing.' : undefined}
        >
          {kindText(g)}
        </span>
        <span className="clean-group-title">
          Group {g.n}
          {g.video ? ' · videos' : ''}
        </span>
        <span className="clean-group-sum">
          {formatCount(live.length)} files · {nMarked ? `${formatCount(nMarked)} selected · ${formatBytes(bytes)}` : 'nothing selected'}
        </span>
        {all && <span className="clean-all-marked">Every copy is selected</span>}
        <div className="spacer" />
        <button className="btn ghost" onClick={onDismiss} title="Keep all of them and stop suggesting this group">
          Not duplicates
        </button>
        <button className="btn ghost" onClick={onAuto} title="Select by the keep rule">
          Auto-select
        </button>
        <button className="btn ghost" onClick={() => onCompare()}>
          <Columns2 size={15} /> Compare
        </button>
      </div>
      <div className="clean-tiles">
        {live.map(([id, i]) => (
          <Tile
            key={id}
            item={byId.get(id)!}
            facts={facts}
            marked={marks.has(id)}
            protectedFile={isProtected(id)}
            showBadge
            match={matchText(g, i)}
            isRef={i === g.ref}
            sharpest={g.sharpest === i}
            onToggle={() => onToggle(id)}
            onOpen={() => onCompare(id)}
            onKeepOnly={() => onKeepOnly(id)}
            onProtectFolder={onProtectFolder}
          />
        ))}
      </div>
    </section>
  )
}

export const Tile = memo(function Tile({
  item,
  facts,
  marked,
  protectedFile,
  showBadge,
  match,
  isRef,
  sharpest,
  onToggle,
  onOpen,
  onKeepOnly,
  onProtectFolder,
}: {
  item: MediaItem
  facts: Facts
  marked: boolean
  protectedFile: boolean
  showBadge: boolean
  match: string
  isRef?: boolean
  sharpest?: boolean
  onToggle(): void
  onOpen(): void
  onKeepOnly?(): void
  onProtectFolder(dir: string): void
}) {
  const f = facts[item.id]
  const dims = f && f[3] ? `${f[3]} × ${f[4]}` : ''
  const details = item.type === 'video' ? [formatDuration(item.duration), formatBytes(item.size)] : [dims, formatBytes(item.size)]
  return (
    <div className={`ctile${marked ? ' marked' : ''}${protectedFile ? ' protected' : ''}`}>
      <button className="ctile-img" onClick={onOpen} title="Open large preview">
        <CoverImage item={item} fallback={<Folder size={24} />} lazy />
        {item.type === 'video' && <span className="ctile-dur">{formatDuration(item.duration)}</span>}
      </button>
      {showBadge &&
        (protectedFile ? (
          <span className="ctile-badge protected">
            <ShieldCheck size={12} /> PROTECTED
          </span>
        ) : (
          <span className={`ctile-badge ${marked ? 'remove' : 'keep'}`}>{marked ? 'REMOVE' : 'KEEP'}</span>
        ))}
      {!protectedFile && (
        <button className={`ctile-check${marked ? ' on' : ''}`} onClick={onToggle} title="Select for removal" aria-pressed={marked}>
          <Check size={13} strokeWidth={3} />
        </button>
      )}
      <div className="ctile-hover">
        <button title="View full screen" onClick={onOpen}>
          <Maximize2 size={14} />
        </button>
        <button title="Always keep files in this folder" onClick={() => onProtectFolder(item.dir)}>
          <Shield size={14} />
        </button>
        <button title="Open with default app" onClick={() => api.openExternal(item.id)}>
          <ExternalLink size={14} />
        </button>
        <button title="Show in folder" onClick={() => api.reveal(item.id)}>
          <FolderOpen size={14} />
        </button>
      </div>
      <div className="ctile-text">
        <div className="ctile-name" title={item.path}>
          {item.name}
        </div>
        <div className="ctile-meta">{details.filter(Boolean).join(' · ')}</div>
        <div className="ctile-meta">{item.taken ? `Taken ${dateFmt.format(item.taken)}` : `Modified ${dateFmt.format(item.mtime)}`}</div>
        <div className="ctile-match">
          <span className={isRef ? 'ref' : ''}>{match}</span>
          {sharpest && <span className="sharpest" title="The clearest shot in this group"> · Sharpest</span>}
          {onKeepOnly && (
            <button className="link ctile-keep" onClick={onKeepOnly}>
              Keep only this
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

export { isUnder }
