import { FileText, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogKeys } from './PersonDialogs'
import './about.css'

interface Credit {
  name: string
  what: string
  license: string
  url: string
  /** A second link, e.g. FFmpeg's source code. */
  extra?: { label: string; url: string }
  /** Restricts how Pics may be used. */
  warn?: boolean
}

// Keep in step with resources/licenses/THIRD-PARTY-NOTICES.txt (full texts and versions are there).
const SOFTWARE: Credit[] = [
  { name: 'Electron', what: 'App framework, with Chromium and Node.js', license: 'MIT', url: 'https://www.electronjs.org' },
  { name: 'React', what: 'The Pics window', license: 'MIT', url: 'https://react.dev' },
  { name: 'Lucide', what: 'Icons', license: 'ISC', url: 'https://lucide.dev' },
  { name: 'Leaflet', what: 'The map, with Leaflet.markercluster (MIT)', license: 'BSD-2-Clause', url: 'https://leafletjs.com' },
  { name: 'exifr', what: 'Reads dates, places and camera details', license: 'MIT', url: 'https://github.com/MikeKovarik/exifr' },
  { name: 'sharp', what: 'Thumbnails, edits and conversions', license: 'Apache 2.0', url: 'https://sharp.pixelplumbing.com' },
  { name: 'libvips', what: 'Image processing inside sharp', license: 'LGPL 3.0', url: 'https://www.libvips.org' },
  { name: 'ONNX Runtime', what: 'Runs the AI models', license: 'MIT', url: 'https://onnxruntime.ai' },
  { name: 'DirectML', what: 'Runs the AI models on the graphics card', license: 'Microsoft', url: 'https://github.com/microsoft/DirectML' },
  {
    name: 'FFmpeg',
    what: 'Video edits, memory movies',
    license: 'GPL 3.0',
    url: 'https://ffmpeg.org',
    extra: { label: 'Source code', url: 'https://github.com/FFmpeg/FFmpeg/commit/ea3d24bbe3' },
  },
]

const MODELS: Credit[] = [
  {
    name: 'InsightFace',
    what: 'Face recognition (People), buffalo_l models',
    license: 'Non-commercial only',
    url: 'https://github.com/deepinsight/insightface',
    warn: true,
  },
  { name: 'Google SigLIP', what: "Search by what's in the photo", license: 'Apache 2.0', url: 'https://huggingface.co/google/siglip-base-patch16-224' },
  { name: 'LaMa', what: 'Magic eraser', license: 'Apache 2.0', url: 'https://github.com/advimman/lama' },
  { name: 'GeoNames', what: 'Place names', license: 'CC BY 4.0', url: 'https://www.geonames.org' },
  { name: 'OpenStreetMap', what: 'Map images © OpenStreetMap contributors', license: 'ODbL', url: 'https://www.openstreetmap.org/copyright' },
]

function CreditList({ items, onOpenUrl }: { items: Credit[]; onOpenUrl(url: string): void }) {
  return (
    <ul className="about-list">
      {items.map((c) => (
        <li key={c.name} className="about-item">
          <div className="about-item-top">
            <button className="link about-item-name" title={c.url} onClick={() => onOpenUrl(c.url)}>
              {c.name}
            </button>
            <span className={`about-license${c.warn ? ' warn' : ''}`}>{c.license}</span>
          </div>
          <div className="about-item-what">
            {c.what}
            {c.extra && (
              <>
                {' · '}
                <button className="link" title={c.extra.url} onClick={() => onOpenUrl(c.extra!.url)}>
                  {c.extra.label}
                </button>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

interface Props {
  version: string
  onOpenUrl(url: string): void
  onShowNotices(): void
}

/** Settings › About & licenses: what Pics is made with, under which licenses. */
export function AboutCard({ version, onOpenUrl, onShowNotices }: Props) {
  return (
    <section className="card about-card">
      <div className="card-head">
        <div>
          <h2>About & licenses</h2>
          <p>Pics {version}</p>
        </div>
        <div className="card-actions">
          <button className="btn ghost" onClick={onShowNotices}>
            <FileText size={15} /> Show all notices
          </button>
        </div>
      </div>
      <p className="about-local">
        Everything runs on this computer: your photos, faces and searches are never uploaded. Only the map uses the internet — while a map is open, Pics loads
        map images from OpenStreetMap.
      </p>
      <div className="about-warning">
        <TriangleAlert size={16} />
        <span>Face recognition uses InsightFace models that are licensed for non-commercial use only.</span>
      </div>
      <h3 className="about-group">Software</h3>
      <CreditList items={SOFTWARE} onOpenUrl={onOpenUrl} />
      <h3 className="about-group">AI models, data and maps</h3>
      <CreditList items={MODELS} onOpenUrl={onOpenUrl} />
      <p className="hint">
        Text in photos, Windows Hello and the HEIF and HEVC extensions are parts of Windows. The notices for Chromium, which Electron includes, are in
        LICENSES.chromium.html in the folder Pics is installed in.
      </p>
    </section>
  )
}

type Doc = 'notices' | 'ffmpeg'

/** The full notices files, read-only. They're loaded only when this opens (~130 KB of text). */
export function NoticesDialog({ onClose }: { onClose(): void }) {
  const [doc, setDoc] = useState<Doc>('notices')
  const [texts, setTexts] = useState<Record<Doc, string> | null>(null)
  const [failed, setFailed] = useState(false)
  const pre = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let live = true
    Promise.all([import('../../resources/licenses/THIRD-PARTY-NOTICES.txt?raw'), import('../../resources/licenses/ffmpeg-source.txt?raw')]).then(
      ([notices, ffmpeg]) => live && setTexts({ notices: notices.default, ffmpeg: ffmpeg.default }),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [])

  // keyboard scrolling works straight away; a new tab starts at the top
  useEffect(() => {
    pre.current?.focus()
    pre.current?.scrollTo(0, 0)
  }, [doc])

  useDialogKeys((e) => {
    if (e.key === 'Escape') onClose()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && pre.current) {
      e.preventDefault()
      getSelection()?.selectAllChildren(pre.current)
    }
  })

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal notices-modal" role="dialog" aria-modal="true" aria-label="Third-party notices" onMouseDown={(e) => e.stopPropagation()}>
        <div className="notices-head">
          <h3>Third-party notices</h3>
          <div className="segmented small">
            <button className={doc === 'notices' ? 'active' : ''} onClick={() => setDoc('notices')}>
              All notices
            </button>
            <button className={doc === 'ffmpeg' ? 'active' : ''} onClick={() => setDoc('ffmpeg')}>
              FFmpeg source code
            </button>
          </div>
        </div>
        <pre ref={pre} className="notices-text" tabIndex={0}>
          {failed ? "The notices couldn't be loaded." : (texts?.[doc] ?? 'Loading…')}
        </pre>
        <p className="notices-foot">These files are also in the folder Pics is installed in, under resources\licenses.</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
