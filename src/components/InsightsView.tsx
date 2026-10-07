import { Copy, Folders, HardDrive, MonitorSmartphone, SunDim, type LucideIcon } from 'lucide-react'
import { memo, useMemo, useState, type CSSProperties } from 'react'
import type { Facts } from '../lib/cleanup'
import { formatBytes } from '../lib/format'
import {
  headlineTiles,
  insightCharts,
  libraryStats,
  plural,
  spaceStats,
  type InsightBar,
  type Measure,
  type ReviewTab,
} from '../lib/insights'
import type { DupGroup, MediaItem } from '../types'
import './insights.css'

// Insights (ported from DupeLens): what the library contains and where space can be freed.

interface Props {
  items: MediaItem[]
  groups: DupGroup[]
  facts: Facts
  /** Library folders (labels in "Biggest folders" are relative to these). */
  roots: string[]
  blurThreshold: number
  largeFileMB: number
  onReview(tab: ReviewTab): void
}

const ICONS: Record<ReviewTab, LucideIcon> = {
  duplicates: Copy,
  quality: SunDim,
  screenshots: MonitorSmartphone,
  folders: Folders,
  large: HardDrive,
}

export function InsightsView({ items, groups, facts, roots, blurThreshold, largeFileMB, onReview }: Props) {
  const [measure, setMeasure] = useState<Measure>('size')
  const lib = useMemo(() => libraryStats(items, roots), [items, roots])
  const space = useMemo(() => spaceStats({ items, groups, facts, blurThreshold, largeFileMB }), [items, groups, facts, blurThreshold, largeFileMB])
  const tiles = useMemo(() => headlineTiles(lib, space), [lib, space])
  const charts = useMemo(() => insightCharts(lib, measure), [lib, measure])

  return (
    <div className="insights">
      <div className="ins-measure">
        <span>Measure by</span>
        <div className="segmented small" role="radiogroup" aria-label="Measure by">
          {(
            [
              ['size', 'Space used'],
              ['count', 'Number of files'],
            ] as [Measure, string][]
          ).map(([m, label]) => (
            <button key={m} role="radio" aria-checked={measure === m} className={measure === m ? 'active' : ''} onClick={() => setMeasure(m)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="ins-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="card ins-tile">
            <div className="ins-tile-label">{t.label}</div>
            <div className="ins-tile-value">{t.value}</div>
            <div className="ins-tile-detail">{t.detail}</div>
          </div>
        ))}
      </div>

      {space.rows.length > 0 && (
        <section className="card ins-card">
          <h2>Where you can free space</h2>
          <p className="ins-caption">Open a list to review it. Nothing is removed until you choose.</p>
          <div className="ins-space">
            {space.rows.map((r) => {
              const Icon = ICONS[r.tab]
              return (
                <div key={r.tab} className="ins-space-row">
                  <span className="ins-space-icon">
                    <Icon size={16} />
                  </span>
                  <div className="ins-space-text">
                    <div className="ins-space-title">{r.title}</div>
                    <div className="ins-space-detail">{r.detail}</div>
                  </div>
                  <div className="ins-space-size">{r.sizeText}</div>
                  <button className="btn" onClick={() => onReview(r.tab)}>
                    Review
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section className="card ins-card">
        <div className="ins-card-head">
          <h2>By year</h2>
          <span className="ins-caption">{charts.yearPeakText}</span>
        </div>
        <p className="ins-caption">When photos were taken (or saved, if the photo doesn't say). Hover a column for details.</p>
        {charts.years.length ? <YearChart bars={charts.years} measure={measure} /> : <Empty />}
      </section>

      <div className="ins-two">
        <section className="card ins-card">
          <h2>By file type</h2>
          <p className="ins-caption">Which formats take up your space.</p>
          {charts.types.length ? <BarList bars={charts.types} measure={measure} /> : <Empty />}
        </section>
        <section className="card ins-card">
          <h2>By camera or phone</h2>
          {charts.cameraNote && <p className="ins-caption">{charts.cameraNote}</p>}
          {charts.cameras.length > 0 && <BarList bars={charts.cameras} measure={measure} />}
          {!lib.photos && <Empty />}
        </section>
      </div>

      <section className="card ins-card">
        <h2>Biggest folders</h2>
        <p className="ins-caption">Files directly inside each folder (subfolders are counted on their own).</p>
        {charts.folders.length ? <BarList bars={charts.folders} measure={measure} /> : <Empty />}
      </section>
    </div>
  )
}

const Empty = () => <div className="ins-empty">Nothing to show yet.</div>

/** Hover / focus card: the label, then files and size (the measured one in bold). */
function Tip({ bar, measure, style, align }: { bar: InsightBar; measure: Measure; style: CSSProperties; align: 'start' | 'center' | 'end' }) {
  const files = plural(bar.count, 'file')
  const size = formatBytes(bar.bytes)
  return (
    <div className={`ins-tip ${align}`} role="tooltip" style={style}>
      <div className="ins-tip-label">{bar.label}</div>
      <div className="ins-tip-value">
        {measure === 'count' ? (
          <>
            <b>{files}</b> · {size}
          </>
        ) : (
          <>
            <b>{size}</b> · {files}
          </>
        )}
      </div>
    </div>
  )
}

const pct = (f: number) => `${(f * 100).toFixed(3)}%`
const ariaText = (b: InsightBar) => b.tooltip.replace('\n', ': ')

/** Columns on a shared baseline; the peak is labelled, the rest on hover. */
const YearChart = memo(function YearChart({ bars, measure }: { bars: InsightBar[]; measure: Measure }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = bars.length
  const hb = hover !== null ? bars[hover] : undefined
  const pos = hover !== null ? (hover + 0.5) / n : 0
  const align = pos < 0.15 ? 'start' : pos > 0.85 ? 'end' : 'center'
  let labelled = 0
  return (
    <div className="ins-years" onMouseLeave={() => setHover(null)}>
      <div className="ins-cols" role="list" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {bars.map((b, i) => (
          <div
            key={b.label}
            role="listitem"
            tabIndex={0}
            aria-label={ariaText(b)}
            className={`ins-col${hover === i ? ' hover' : ''}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover((h) => (h === i ? null : h))}
          >
            <div className="ins-col-plot">
              {b.value > 0 && <div className="ins-col-bar" style={{ height: pct(b.fraction) }} />}
              {b.isPeak && (
                <span className="ins-col-peak" style={{ bottom: `calc(${pct(b.fraction)} + 4px)` }}>
                  {b.valueText}
                </span>
              )}
            </div>
            {/* every second label hides on narrow charts */}
            <div className={`ins-col-axis${b.axis && labelled++ % 2 ? ' alt' : ''}`}>
              <span>{b.axis}</span>
            </div>
          </div>
        ))}
      </div>
      {hb && (
        <Tip
          bar={hb}
          measure={measure}
          align={align}
          style={{ left: align === 'start' ? `${(hover! / n) * 100}%` : align === 'end' ? `${((hover! + 1) / n) * 100}%` : pct(pos), bottom: `calc(var(--ins-axis-h) + var(--ins-plot-h) * ${hb.fraction} + ${hb.isPeak ? 28 : 10}px)` }}
        />
      )}
    </div>
  )
})

/** Horizontal bars: label | bar with its value at the tip. */
const BarList = memo(function BarList({ bars, measure }: { bars: InsightBar[]; measure: Measure }) {
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div className="ins-bars" role="list" onMouseLeave={() => setHover(null)}>
      {bars.map((b, i) => (
        <div
          key={i}
          role="listitem"
          tabIndex={0}
          aria-label={ariaText(b)}
          className={`ins-bar-row${hover === i ? ' hover' : ''}`}
          onMouseEnter={() => setHover(i)}
          onFocus={() => setHover(i)}
          onBlur={() => setHover((h) => (h === i ? null : h))}
        >
          <span className="ins-bar-label">{b.label}</span>
          <div className="ins-bar-track">
            {b.value > 0 && <div className="ins-bar" style={{ width: pct(b.fraction) }} />}
            <span className="ins-bar-value">{b.valueText}</span>
            {hover === i && <Tip bar={b} measure={measure} align={b.fraction < 0.2 ? 'start' : 'center'} style={{ left: b.fraction < 0.2 ? 0 : pct(b.fraction / 2) }} />}
          </div>
        </div>
      ))}
    </div>
  )
})
