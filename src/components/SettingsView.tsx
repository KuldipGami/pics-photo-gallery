import {
  Check,
  Cpu,
  FolderOpen,
  FolderPlus,
  Gpu,
  HardDrive,
  Monitor,
  Moon,
  RefreshCw,
  RotateCcw,
  ScanFace,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api'
import { formatBytes, formatCount } from '../lib/format'
import type { GpuInfo, MediaItem, PeopleData, PeopleProgress, Settings, SmartProgress, Theme } from '../types'
import type { ConfirmOptions } from './Overlays'

export const ACCENTS = ['#5b8cff', '#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4']

const SHORTCUTS: [string, string][] = [
  ['Ctrl F', 'Search'],
  ['Ctrl + / Ctrl −', 'Bigger / smaller thumbnails'],
  ['Ctrl A', 'Select all'],
  ['Ctrl / Shift + click', 'Select / select range'],
  ['Del', 'Move to Recycle Bin'],
  ['F5', 'Rescan library'],
  ['← →', 'Previous / next (viewer)'],
  ['Space', 'Slideshow · play/pause video'],
  ['Wheel · double-click', 'Zoom photo'],
  ['F', 'Favorite'],
  ['I', 'Details panel'],
]

interface Props {
  settings: Settings
  items: MediaItem[]
  version: string
  people: PeopleData
  peopleProgress: PeopleProgress
  smartProgress: SmartProgress
  onAddFolder(): void
  onToast(text: string): void
  onConfirm(options: ConfirmOptions): void
}

export function SettingsView({ settings, items, version, people, peopleProgress, smartProgress, onAddFolder, onToast, onConfirm }: Props) {
  const engine = peopleProgress.engine
  const smartEngine = smartProgress.engine
  const [cache, setCache] = useState<{ bytes: number; files: number } | null>(null)
  const [gpu, setGpu] = useState<GpuInfo | null>(null)
  useEffect(() => {
    api.cacheInfo().then(setCache)
    api.getGpu().then(setGpu)
  }, [])

  const perFolder = useMemo(() => {
    const norm = (p: string) => p.toLowerCase().replace(/[\\/]+/g, '/').replace(/\/$/, '')
    const roots = settings.folders.map((f) => ({ f, prefix: norm(f) + '/' }))
    const counts = new Map<string, number>()
    for (const it of items) {
      const p = norm(it.path)
      for (const r of roots) if (p.startsWith(r.prefix)) counts.set(r.f, (counts.get(r.f) ?? 0) + 1)
    }
    return counts
  }, [items, settings.folders])

  const themes: [Theme, string, ReactNode][] = [
    ['system', 'System', <Monitor size={16} />],
    ['light', 'Light', <Sun size={16} />],
    ['dark', 'Dark', <Moon size={16} />],
  ]

  return (
    <div className="settings-scroll">
      <div className="settings">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Library folders</h2>
              <p>Lumen shows every photo and video inside these folders, including subfolders.</p>
            </div>
            <div className="card-actions">
              <button className="btn ghost" onClick={() => api.rescan()}>
                <RefreshCw size={15} /> Rescan
              </button>
              <button className="btn primary" onClick={onAddFolder}>
                <FolderPlus size={15} /> Add folder
              </button>
            </div>
          </div>
          <div className="folder-list">
            {settings.folders.length === 0 && <div className="folder-empty">No folders yet — add one to get started.</div>}
            {settings.folders.map((f) => (
              <div key={f} className="folder-row">
                <FolderOpen size={18} />
                <div className="folder-row-text">
                  <div className="folder-row-path">{f}</div>
                  <div className="folder-row-count">{formatCount(perFolder.get(f) ?? 0)} items</div>
                </div>
                <button className="icon-btn" title="Open in Explorer" onClick={() => api.revealFolder(f)}>
                  <FolderOpen size={16} />
                </button>
                <button className="icon-btn" title="Remove from library" onClick={() => api.removeFolder(f)}>
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
          <p className="hint">Tip: drag a folder from Explorer onto this window to add it. Removing a folder never deletes files.</p>
        </section>

        <section className="card">
          <h2>Appearance</h2>
          <div className="setting-row">
            <span>Theme</span>
            <div className="segmented">
              {themes.map(([value, label, icon]) => (
                <button
                  key={value}
                  className={settings.theme === value ? 'active' : ''}
                  onClick={() => api.setSettings({ theme: value })}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <span>Accent color</span>
            <div className="swatches">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  className={`swatch${settings.accent === c ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => api.setSettings({ accent: c })}
                  aria-label={`Accent ${c}`}
                >
                  {settings.accent === c && <Check size={14} strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="card">
          <h2>People</h2>
          <div className="setting-row">
            <div>
              <div>Recognize faces</div>
              <div className="setting-hint">
                Groups your photos by the people in them. Faces are analysed on this computer (on the GPU) — nothing
                is uploaded.
              </div>
            </div>
            <button
              role="switch"
              aria-checked={settings.faceRecognition}
              className={`switch${settings.faceRecognition ? ' on' : ''}`}
              onClick={() => api.setSettings({ faceRecognition: !settings.faceRecognition })}
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <span className="with-icon">
              <Cpu size={16} /> Face model
            </span>
            <div className="setting-value">
              <span className="gpu-name">InsightFace ArcFace (buffalo_l)</span>
              {engine ? (
                <span className={`pill${engine.device === 'gpu' ? ' ok' : ''}`}>
                  {engine.device === 'gpu' ? 'Running on GPU (DirectML)' : 'Running on CPU'}
                </span>
              ) : (
                <span className="pill">Starts when needed</span>
              )}
            </div>
          </div>
          <div className="setting-row">
            <span className="with-icon">
              <ScanFace size={16} /> Face data
            </span>
            <div className="setting-value">
              {formatCount(people.faces)} faces in {formatCount(people.analysed)} photos · {formatCount(people.people.length)}{' '}
              people
              <button
                className="btn ghost"
                disabled={!people.analysed}
                onClick={() =>
                  onConfirm({
                    title: 'Delete all face data?',
                    message:
                      'Names, groupings and corrections will be removed. If face recognition stays on, your photos are analysed again from scratch.',
                    confirmLabel: 'Delete face data',
                    danger: true,
                    onConfirm: () => {
                      api.resetPeople()
                      onToast('Face data deleted')
                    },
                  })
                }
              >
                Delete…
              </button>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Search</h2>
          <div className="setting-row">
            <div>
              <div>Search by what's in the photo</div>
              <div className="setting-hint">
                Find photos by describing them — “beach”, “dog”, “birthday cake”, “receipt”. Photos are analysed on this
                computer (on the GPU) — nothing is uploaded.
              </div>
            </div>
            <button
              role="switch"
              aria-checked={settings.smartSearch}
              className={`switch${settings.smartSearch ? ' on' : ''}`}
              onClick={() => api.setSettings({ smartSearch: !settings.smartSearch })}
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <span className="with-icon">
              <Sparkles size={16} /> Search model
            </span>
            <div className="setting-value">
              <span className="gpu-name">Google SigLIP</span>
              {!smartProgress.available ? (
                <span className="pill">Not installed</span>
              ) : smartEngine ? (
                <span className={`pill${smartEngine.device === 'gpu' ? ' ok' : ''}`}>
                  {smartEngine.device === 'gpu' ? 'Running on GPU (DirectML)' : 'Running on CPU'}
                </span>
              ) : (
                <span className="pill">Starts when needed</span>
              )}
            </div>
          </div>
          <div className="setting-row">
            <span className="with-icon">
              <ScanSearch size={16} /> Ready to search
            </span>
            <div className="setting-value">
              {formatCount(smartProgress.indexed)} of {formatCount(items.length)} items
              {smartProgress.running && smartProgress.total
                ? ` · preparing ${Math.floor((smartProgress.done / smartProgress.total) * 100)}%`
                : ''}
            </div>
          </div>
          {smartProgress.error && <p className="hint">Smart search couldn't start: {smartProgress.error}</p>}
        </section>

        <section className="card">
          <h2>Clean up</h2>
          <div className="setting-row">
            <div>
              <div>Match threshold · {settings.dupeSensitivity}%</div>
              <div className="setting-hint">
                {settings.dupeSensitivity >= 95
                  ? 'Strict: only near-identical copies'
                  : settings.dupeSensitivity >= 89
                    ? 'Balanced: recommended'
                    : settings.dupeSensitivity >= 85
                      ? 'Loose: may include burst shots'
                      : 'Very loose: review matches carefully'}
              </div>
            </div>
            <div className="range-with-ends">
              <span>More matches</span>
              <input
                type="range"
                min={80}
                max={99}
                value={settings.dupeSensitivity}
                onChange={(e) => api.setSettings({ dupeSensitivity: Number(e.target.value) })}
              />
              <span>Stricter</span>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div>Match cropped copies</div>
              <div className="setting-hint">Also finds copies with the edges cut off. Rotated and mirrored copies are always found.</div>
            </div>
            <button
              role="switch"
              aria-checked={settings.findCrops}
              className={`switch${settings.findCrops ? ' on' : ''}`}
              onClick={() => api.setSettings({ findCrops: !settings.findCrops })}
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <div>
              <div>Blur sensitivity · {settings.blurThreshold}</div>
              <div className="setting-hint">
                {settings.blurThreshold <= 15 ? 'Only very blurry photos' : settings.blurThreshold <= 40 ? 'Balanced' : 'Also flags soft or out-of-focus photos'}
              </div>
            </div>
            <input type="range" min={5} max={80} value={settings.blurThreshold} onChange={(e) => api.setSettings({ blurThreshold: Number(e.target.value) })} />
          </div>
          <div className="setting-row">
            <div>
              <div>Large files · over {settings.largeFileMB} MB</div>
              <div className="setting-hint">Shown under Clean up → Large files.</div>
            </div>
            <input type="range" min={5} max={500} step={5} value={settings.largeFileMB} onChange={(e) => api.setSettings({ largeFileMB: Number(e.target.value) })} />
          </div>
          <div className="setting-row">
            <div>
              <div>Move duplicates to</div>
              <div className="setting-hint folder-row-path">{settings.moveDestination ?? `${settings.defaultMoveDestination} (default)`}</div>
            </div>
            <div className="card-actions">
              {settings.moveDestination && (
                <button className="btn ghost" onClick={() => api.setSettings({ moveDestination: null })}>
                  Reset
                </button>
              )}
              <button className="btn ghost" onClick={() => api.pickDestination()}>
                Change…
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div>Keep the original date on kept copies</div>
              <div className="setting-hint">
                If you keep a copy that lost its date (like a WhatsApp copy) and remove the original, the kept file gets the original's date.
              </div>
            </div>
            <button
              role="switch"
              aria-checked={settings.carryDates}
              className={`switch${settings.carryDates ? ' on' : ''}`}
              onClick={() => api.setSettings({ carryDates: !settings.carryDates })}
            >
              <span />
            </button>
          </div>
          <div className="setting-row column">
            <div className="setting-row-head">
              <div>
                <div>Always keep (protected folders)</div>
                <div className="setting-hint">Files in these folders (e.g. your camera originals) are never selected for removal.</div>
              </div>
              <button
                className="btn ghost"
                onClick={async () => {
                  const picked = await api.pickFolders('Protect a folder')
                  if (picked.length) api.setSettings({ protectedFolders: [...new Set([...settings.protectedFolders, ...picked])] })
                }}
              >
                <ShieldCheck size={15} /> Protect a folder…
              </button>
            </div>
            {settings.protectedFolders.length > 0 && (
              <div className="folder-list">
                {settings.protectedFolders.map((f) => (
                  <div key={f} className="folder-row">
                    <ShieldCheck size={18} />
                    <div className="folder-row-text">
                      <div className="folder-row-path">{f}</div>
                    </div>
                    <button
                      className="icon-btn"
                      title="Stop protecting this folder"
                      onClick={() => api.setSettings({ protectedFolders: settings.protectedFolders.filter((x) => x !== f) })}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <h2>Performance</h2>
          <div className="setting-row">
            <span className="with-icon">
              <Gpu size={16} /> Graphics in use
            </span>
            <div className="setting-value">
              {gpu ? (
                <>
                  <span className="gpu-name">{gpu.name}</span>
                  {gpu.hardwareVideoDecode && <span className="pill ok">Hardware video decoding</span>}
                </>
              ) : (
                'Checking…'
              )}
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div>Use high-performance GPU</div>
              <div className="setting-hint">
                On laptops with two graphics chips (e.g. Intel + NVIDIA), use the faster one for video previews and
                scrolling. Uses a little more battery.
              </div>
            </div>
            <button
              role="switch"
              aria-checked={settings.highPerformanceGpu}
              className={`switch${settings.highPerformanceGpu ? ' on' : ''}`}
              onClick={() => api.setSettings({ highPerformanceGpu: !settings.highPerformanceGpu })}
            >
              <span />
            </button>
          </div>
          {gpu && gpu.highPerformanceRequested !== settings.highPerformanceGpu && (
            <div className="restart-note">
              <span>Restart Lumen to switch graphics.</span>
              <button className="btn primary" onClick={() => api.relaunch()}>
                <RotateCcw size={15} /> Restart now
              </button>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Storage</h2>
          <div className="setting-row">
            <span className="with-icon">
              <HardDrive size={16} /> Thumbnail cache
            </span>
            <div className="setting-value">
              {cache ? `${formatBytes(cache.bytes)} · ${formatCount(cache.files)} files` : '…'}
              <button
                className="btn ghost"
                onClick={async () => {
                  await api.clearCache()
                  setCache(await api.cacheInfo())
                  onToast('Thumbnail cache cleared')
                }}
              >
                Clear
              </button>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Keyboard shortcuts</h2>
          <div className="shortcuts">
            {SHORTCUTS.map(([keys, label]) => (
              <div key={keys} className="shortcut">
                <kbd>{keys}</kbd>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </section>

        <p className="about">Lumen {version} · Your photos never leave this computer.</p>
        <p className="about credits">
          Faces: InsightFace buffalo_l (non-commercial licence) · Smart search: Google SigLIP (Apache 2.0) · Place names:{' '}
          <button className="link" onClick={() => api.openUrl('https://www.geonames.org/')}>
            GeoNames
          </button>{' '}
          (CC BY 4.0)
        </p>
      </div>
    </div>
  )
}
