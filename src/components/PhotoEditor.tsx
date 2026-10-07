import { Check, FlipHorizontal2, LoaderCircle, RotateCcw, RotateCw, Undo2, Wand2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { api } from '../api'
import { useElementSize } from '../hooks'
import type { EditRecipe, MediaItem } from '../types'

const EMPTY: EditRecipe = { quarter: 0, flip: false, straighten: 0, crop: null, enhance: false, light: 0, contrast: 0, color: 0, warmth: 0 }
const MIN = 0.04 // smallest crop, as a fraction of the picture
type Rect = { x: number; y: number; w: number; h: number }
type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const changed = (r: EditRecipe) => JSON.stringify(r) !== JSON.stringify(EMPTY)

/** Largest centred rectangle with pixel aspect `ratio` in a pw×ph picture, as fractions. */
function fitAspect(ratio: number, pw: number, ph: number): Rect {
  let w = 1
  let h = (pw / ph) / ratio
  if (h > 1) {
    h = 1
    w = (ph / pw) * ratio
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

interface Props {
  item: MediaItem
  onClose(): void
  onSaved(id: string, name: string): void
  onToast(text: string): void
}

export function PhotoEditor({ item, onClose, onSaved, onToast }: Props) {
  const [recipe, setRecipe] = useState<EditRecipe>(EMPTY)
  const [preview, setPreview] = useState<{ url: string; w: number; h: number } | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [aspect, setAspect] = useState<string>('free')
  const [saving, setSaving] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const stage = useElementSize(stageRef)

  // Everything except the crop is rendered by the main process (same code as the saved copy);
  // the crop is drawn on top so it can be dragged freely.
  const renderKey = JSON.stringify({ ...recipe, crop: null })
  useEffect(() => {
    let live = true
    setBusy(true)
    const t = setTimeout(async () => {
      const res = await api.editPreview(item.id, { ...recipe, crop: null }, 1600)
      if (!live) return
      setBusy(false)
      if ('error' in res) return setError(res.error)
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'image/jpeg' }))
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old.url)
        return { url, w: res.width, h: res.height }
      })
    }, 80)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [renderKey, item.id])
  useEffect(() => () => void api.editClose(), [])

  const set = (patch: Partial<EditRecipe>) => setRecipe((r) => ({ ...r, ...patch }))
  const pw = preview?.w ?? 1
  const ph = preview?.h ?? 1

  const ratios: [string, string, number | null][] = useMemo(() => {
    const land = pw >= ph
    const r = (a: number, b: number) => (land ? a / b : b / a)
    return [
      ['free', 'Free', null],
      ['original', 'Original', pw / ph],
      ['square', 'Square', 1],
      ['4:3', land ? '4:3' : '3:4', r(4, 3)],
      ['3:2', land ? '3:2' : '2:3', r(3, 2)],
      ['16:9', land ? '16:9' : '9:16', r(16, 9)],
    ]
  }, [pw, ph])
  const lockRatio = ratios.find(([key]) => key === aspect)?.[2] ?? null

  const chooseAspect = (key: string) => {
    setAspect(key)
    const ratio = ratios.find(([k]) => k === key)?.[2]
    set({ crop: ratio ? fitAspect(ratio, pw, ph) : recipe.crop })
  }
  const turn = (dir: 1 | -1) => {
    setAspect('free')
    set({ quarter: (recipe.quarter + dir + 4) % 4, crop: null })
  }

  // ---------- crop dragging ----------
  const scale = preview ? Math.min((stage.width - 48) / pw, (stage.height - 48) / ph, 4) : 1
  const dispW = Math.max(1, pw * scale)
  const dispH = Math.max(1, ph * scale)
  const drag = useRef<{ handle: Handle; x: number; y: number; start: Rect } | null>(null)
  const crop: Rect = recipe.crop ?? { x: 0, y: 0, w: 1, h: 1 }

  const onDown = (handle: Handle) => (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { handle, x: e.clientX, y: e.clientY, start: crop }
  }
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / dispW
    const dy = (e.clientY - d.y) / dispH
    const s = d.start
    let { x, y, w, h } = s
    if (d.handle === 'move') {
      x = Math.min(1 - w, Math.max(0, s.x + dx))
      y = Math.min(1 - h, Math.max(0, s.y + dy))
    } else {
      const H = d.handle
      let left = s.x
      let top = s.y
      let right = s.x + s.w
      let bottom = s.y + s.h
      if (H.includes('w')) left = Math.min(right - MIN, Math.max(0, s.x + dx))
      if (H.includes('e')) right = Math.max(left + MIN, Math.min(1, s.x + s.w + dx))
      if (H.includes('n')) top = Math.min(bottom - MIN, Math.max(0, s.y + dy))
      if (H.includes('s')) bottom = Math.max(top + MIN, Math.min(1, s.y + s.h + dy))
      w = right - left
      h = bottom - top
      x = left
      y = top
      if (lockRatio) {
        // keep the chosen proportions: the dragged side wins, the other follows (within the picture)
        const horizontal = H === 'e' || H === 'w' || H.length === 2
        if (horizontal) h = (w * pw) / (ph * lockRatio)
        else w = (h * ph * lockRatio) / pw
        if (h > 1) {
          h = 1
          w = (h * ph * lockRatio) / pw
        }
        if (w > 1) {
          w = 1
          h = (w * pw) / (ph * lockRatio)
        }
        x = H.includes('w') ? right - w : H === 'n' || H === 's' ? s.x + (s.w - w) / 2 : left
        y = H.includes('n') ? bottom - h : H === 'e' || H === 'w' ? s.y + (s.h - h) / 2 : top
        x = Math.min(1 - w, Math.max(0, x))
        y = Math.min(1 - h, Math.max(0, y))
      }
    }
    const full = x <= 0.001 && y <= 0.001 && w >= 0.999 && h >= 0.999
    set({ crop: full ? null : { x, y, w, h } })
  }
  const onUp = () => (drag.current = null)

  // ---------- saving / closing ----------
  const save = async () => {
    if (!changed(recipe) || saving) return
    setSaving(true)
    const res = await api.editSave(item.id, recipe)
    setSaving(false)
    if ('error' in res) return onToast(res.error)
    onSaved(res.id, res.name)
  }
  const close = () => (changed(recipe) ? setConfirmClose(true) : onClose())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input[type="text"], textarea')) return
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        if (confirmClose) setConfirmClose(false)
        else close()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        setRecipe(EMPTY)
        setAspect('free')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const slider = (label: string, key: 'light' | 'contrast' | 'color' | 'warmth') => (
    <label className="edit-slider">
      <span>
        {label}
        <b>{Math.round(recipe[key] * 100)}</b>
      </span>
      <input
        type="range"
        min={-100}
        max={100}
        value={Math.round(recipe[key] * 100)}
        onChange={(e) => set({ [key]: Number(e.target.value) / 100 })}
        onDoubleClick={() => set({ [key]: 0 })}
      />
    </label>
  )
  const section = (title: string, children: ReactNode) => (
    <section className="edit-section">
      <h4>{title}</h4>
      {children}
    </section>
  )

  return (
    <div className="editor" role="dialog" aria-label="Edit photo">
      <div className="editor-stage" ref={stageRef} onPointerMove={onMove} onPointerUp={onUp}>
        {error ? (
          <div className="viewer-error">
            <p>{error}</p>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        ) : preview ? (
          <div className="editor-canvas" style={{ width: dispW, height: dispH }}>
            <img src={preview.url} alt="" draggable={false} />
            <div
              className="crop-box"
              style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
              onPointerDown={onDown('move')}
            >
              <div className="crop-grid" />
              {HANDLES.map((h) => (
                <span key={h} className={`crop-handle ${h}`} onPointerDown={onDown(h)} />
              ))}
            </div>
          </div>
        ) : null}
        {busy && !error && (
          <div className="editor-busy">
            <LoaderCircle size={18} className="spin" />
          </div>
        )}
      </div>

      <aside className="editor-panel">
        <div className="editor-head">
          <h3>Edit</h3>
          <button className="icon-btn" onClick={close} title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="editor-tools">
          {section(
            'Crop & rotate',
            <>
              <div className="edit-row">
                <button className="btn ghost" onClick={() => turn(-1)} title="Rotate left">
                  <RotateCcw size={16} /> Left
                </button>
                <button className="btn ghost" onClick={() => turn(1)} title="Rotate right">
                  <RotateCw size={16} /> Right
                </button>
                <button className={`btn ghost${recipe.flip ? ' on' : ''}`} onClick={() => set({ flip: !recipe.flip })} title="Mirror">
                  <FlipHorizontal2 size={16} /> Flip
                </button>
              </div>
              <label className="edit-slider">
                <span>
                  Straighten
                  <b>{recipe.straighten.toFixed(1)}°</b>
                </span>
                <input
                  type="range"
                  min={-45}
                  max={45}
                  step={0.5}
                  value={recipe.straighten}
                  onChange={(e) => set({ straighten: Number(e.target.value) })}
                  onDoubleClick={() => set({ straighten: 0 })}
                />
              </label>
              <div className="edit-chips">
                {ratios.map(([key, label]) => (
                  <button key={key} className={`chip${aspect === key ? ' active' : ''}`} onClick={() => chooseAspect(key)}>
                    {label}
                  </button>
                ))}
              </div>
              <p className="edit-hint">Drag the frame's corners or edges on the photo to crop.</p>
            </>,
          )}
          {section(
            'Light & colour',
            <>
              <button className={`btn enhance${recipe.enhance ? ' on' : ''}`} onClick={() => set({ enhance: !recipe.enhance })}>
                <Wand2 size={16} /> Auto-enhance
                {recipe.enhance && <Check size={15} />}
              </button>
              {slider('Light', 'light')}
              {slider('Contrast', 'contrast')}
              {slider('Colour', 'color')}
              {slider('Warmth', 'warmth')}
            </>,
          )}
        </div>
        <div className="editor-foot">
          <button
            className="btn ghost"
            disabled={!changed(recipe)}
            onClick={() => {
              setRecipe(EMPTY)
              setAspect('free')
            }}
            title="Undo all changes (Ctrl+Z)"
          >
            <Undo2 size={15} /> Reset
          </button>
          <div className="spacer" />
          <button className="btn primary" disabled={!changed(recipe) || saving || !!error} onClick={save} title="Save as a new copy (Ctrl+S)">
            {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Save copy
          </button>
        </div>
        <p className="edit-note">Saved as a new file next to the original — your original is never changed.</p>
      </aside>

      {confirmClose && (
        <div className="modal-backdrop" onMouseDown={() => setConfirmClose(false)}>
          <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <h3>Discard your edits?</h3>
            <p>Nothing has been saved yet.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmClose(false)}>
                Keep editing
              </button>
              <button className="btn danger" onClick={onClose}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
