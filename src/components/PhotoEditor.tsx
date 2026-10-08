import {
  Brush,
  Check,
  Eraser,
  FlipHorizontal2,
  LoaderCircle,
  RotateCcw,
  RotateCw,
  SquareSplitHorizontal,
  Undo2,
  Wand2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { api } from '../api'
import { useElementSize } from '../hooks'
import type { EditRecipe, MediaItem } from '../types'
import './eraser.css'

// ---------- magic eraser (see electron/eraser.cjs) ----------
/** A brush stroke: diameter as a fraction of the picture's long side; x, y pairs as fractions of it. */
type EraseStroke = { size: number; points: number[] }
/** One press of "Erase", in the upright photo's coordinates (made by the main process). */
type EraseStep = { strokes: EraseStroke[] }
type Recipe = EditRecipe & { erase: EraseStep[] }
type EraserStatus = { available: boolean; ready: boolean; device: string | null; error?: string }
type EraseResult = { step: EraseStep; ms: number; device: string | null; regions: number } | { error: string }
/** The eraser's calls (optional: older builds don't have them). */
const eraserApi = api as unknown as {
  editErase?(id: string, recipe: Recipe, strokes: EraseStroke[]): Promise<EraseResult>
  eraserStatus?(warm?: boolean): Promise<EraserStatus>
}
const BRUSH_MIN = 6
const BRUSH_MAX = 200

const EMPTY: Recipe = { quarter: 0, flip: false, straighten: 0, crop: null, enhance: false, light: 0, contrast: 0, color: 0, warmth: 0, erase: [] }
const MIN = 0.04 // smallest crop, as a fraction of the picture
type Rect = { x: number; y: number; w: number; h: number }
type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const changed = (r: Recipe) => JSON.stringify(r) !== JSON.stringify(EMPTY)

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

/** Draws strokes (fractions of a w×h canvas) in one solid colour; the layer itself is see-through. */
function drawStrokes(ctx: CanvasRenderingContext2D, strokes: EraseStroke[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = ctx.strokeStyle = '#ff3b6b'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const long = Math.max(w, h)
  for (const s of strokes) {
    const p = s.points
    ctx.lineWidth = s.size * long
    if (p.length === 2) {
      ctx.beginPath()
      ctx.arc(p[0] * w, p[1] * h, ctx.lineWidth / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.beginPath()
    ctx.moveTo(p[0] * w, p[1] * h)
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * w, p[i + 1] * h)
    ctx.stroke()
  }
}

interface Props {
  item: MediaItem
  onClose(): void
  onSaved(id: string, name: string): void
  onToast(text: string): void
}

export function PhotoEditor({ item, onClose, onSaved, onToast }: Props) {
  const [recipe, setRecipe] = useState<Recipe>(EMPTY)
  const [preview, setPreview] = useState<{ url: string; w: number; h: number } | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [aspect, setAspect] = useState<string>('free')
  const [saving, setSaving] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  /** "Reset" (or Ctrl+Z) with magic eraser steps, which take a while to redo: asked first. */
  const [confirmReset, setConfirmReset] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const stage = useElementSize(stageRef)

  // magic eraser
  const [tool, setTool] = useState<'crop' | 'erase'>('crop')
  const [brush, setBrush] = useState(40) // screen pixels
  const [strokes, setStrokes] = useState<EraseStroke[]>([])
  const [erasing, setErasing] = useState(false)
  const [eraser, setEraser] = useState<EraserStatus | null>(null)
  const [comparing, setComparing] = useState(false)
  const [before, setBefore] = useState<{ key: string; url: string } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const paintRef = useRef<HTMLCanvasElement>(null)
  const painting = useRef<EraseStroke | null>(null)

  // Everything except the crop is rendered by the main process (same code as the saved copy);
  // the crop is drawn on top so it can be dragged freely.
  const renderKey = JSON.stringify({ ...recipe, crop: null })
  const previewUrl = useRef<string | null>(null)
  useEffect(() => {
    let live = true
    setBusy(true)
    const t = setTimeout(async () => {
      const res = await api.editPreview(item.id, { ...recipe, crop: null }, 1600)
      if (!live) return
      setBusy(false)
      if ('error' in res) return setError(res.error)
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'image/jpeg' }))
      previewUrl.current = url
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
  // the last preview's picture is let go when the editor closes
  useEffect(
    () => () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
      void api.editClose()
    },
    [],
  )

  const set = (patch: Partial<Recipe>) => setRecipe((r) => ({ ...r, ...patch }))
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

  // ---------- magic eraser ----------
  const canErase = !!eraserApi.editErase && !!eraser?.available
  useEffect(() => {
    if (!eraserApi.eraserStatus) return setEraser({ available: false, ready: false, device: null })
    let live = true
    eraserApi.eraserStatus(false).then((s) => live && setEraser(s))
    return () => {
      live = false
    }
  }, [])
  // Load the model while the brush is out (a few seconds the first time), checking until it's ready.
  const warmed = useRef(false)
  useEffect(() => {
    if (tool !== 'erase' || !eraserApi.eraserStatus || !eraser?.available || eraser.ready || eraser.error) return
    let live = true
    const t = setTimeout(async () => {
      const s = await eraserApi.eraserStatus!(true)
      if (live) setEraser(s)
    }, warmed.current ? 800 : 0)
    warmed.current = true
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [tool, eraser])
  // Strokes waiting to be erased belong to the picture as it is turned now.
  useEffect(() => setStrokes([]), [recipe.quarter, recipe.flip, recipe.straighten])
  useEffect(() => {
    const canvas = paintRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(dispW * dpr)
    canvas.height = Math.round(dispH * dpr)
    const ctx = canvas.getContext('2d')
    if (ctx) drawStrokes(ctx, strokes, canvas.width, canvas.height)
  }, [strokes, dispW, dispH, tool, comparing])

  const paintPoint = (e: ReactPointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] as const
  }
  const onPaintDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (erasing || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const [x, y] = paintPoint(e)
    painting.current = { size: brush / Math.max(dispW, dispH), points: [x, y] }
    const canvas = e.currentTarget
    const ctx = canvas.getContext('2d')
    if (ctx) drawStrokes(ctx, [...strokes, painting.current], canvas.width, canvas.height)
  }
  const onPaintMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
    const s = painting.current
    if (!s) return
    const [x, y] = paintPoint(e)
    const n = s.points.length
    if (Math.hypot((x - s.points[n - 2]) * dispW, (y - s.points[n - 1]) * dispH) < 2) return
    s.points.push(x, y)
    const canvas = e.currentTarget
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // just the new piece
    const long = Math.max(canvas.width, canvas.height)
    ctx.lineWidth = s.size * long
    ctx.beginPath()
    ctx.moveTo(s.points[n - 2] * canvas.width, s.points[n - 1] * canvas.height)
    ctx.lineTo(x * canvas.width, y * canvas.height)
    ctx.stroke()
  }
  const onPaintUp = () => {
    const s = painting.current
    painting.current = null
    if (s) setStrokes((list) => [...list, s])
  }

  const runErase = async () => {
    if (!strokes.length || erasing || !eraserApi.editErase) return
    setErasing(true)
    const res = await eraserApi.editErase(item.id, recipe, strokes)
    setErasing(false)
    if ('error' in res) return onToast(res.error)
    setStrokes([])
    setRecipe((r) => ({ ...r, erase: [...r.erase, res.step] }))
    setEraser((s) => (s ? { ...s, ready: true } : s))
  }
  const undoErase = () => set({ erase: recipe.erase.slice(0, -1) })
  const chooseTool = (next: 'crop' | 'erase') => {
    setTool(next)
    if (next === 'crop') setStrokes([])
  }

  // Compare: the same edit without the erasing, while the button is held.
  const beforeKey = JSON.stringify({ ...recipe, crop: null, erase: [] })
  useEffect(() => {
    if (!comparing || before?.key === beforeKey) return
    let live = true
    api.editPreview(item.id, { ...recipe, crop: null, erase: [] } as Recipe, 1600).then((res) => {
      if (!live || 'error' in res) return
      setBefore({ key: beforeKey, url: URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'image/jpeg' })) })
    })
    return () => {
      live = false
    }
  }, [comparing, beforeKey])
  useEffect(() => () => void (before && URL.revokeObjectURL(before.url)), [before]) // the one it replaces, or on close

  // ---------- saving / closing ----------
  const save = async () => {
    // (Ctrl+S too: not while an erase is still being filled in, or after the photo failed to open)
    if (!changed(recipe) || saving || erasing || error) return
    setSaving(true)
    const res = await api.editSave(item.id, recipe)
    setSaving(false)
    if ('error' in res) return onToast(res.error)
    onSaved(res.id, res.name)
  }
  const close = () => (changed(recipe) ? setConfirmClose(true) : onClose())
  const resetAll = () => {
    setRecipe(EMPTY)
    setAspect('free')
    setStrokes([])
    setConfirmReset(false)
  }
  const reset = () => (recipe.erase.length ? setConfirmReset(true) : resetAll())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input[type="text"], textarea')) return
      e.stopPropagation()
      const erase = tool === 'erase' && !confirmClose
      if (confirmReset) {
        // only the question's own keys
        if (e.key === 'Escape') {
          e.preventDefault()
          setConfirmReset(false)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (confirmClose) setConfirmClose(false)
        else if (erase && strokes.length) setStrokes([])
        else if (erase) chooseTool('crop')
        else close()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (erase && strokes.length) setStrokes((list) => list.slice(0, -1))
        else if (erase && recipe.erase.length) undoErase()
        else if (!erase && !confirmClose && changed(recipe)) reset()
      } else if (erase && e.key === 'Enter') {
        e.preventDefault()
        runErase()
      } else if (erase && (e.key === '[' || e.key === ']')) {
        setBrush((b) => Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, Math.round(b * (e.key === ']' ? 1.2 : 1 / 1.2)))))
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

  const erasingMode = tool === 'erase' && canErase
  const eraserHint = !eraser
    ? ''
    : !eraser.available || !eraserApi.editErase
      ? "The magic eraser isn't included in this copy of Pics."
      : eraser.error
        ? eraser.error
        : erasing
          ? 'Filling in the background…'
          : tool !== 'erase'
            ? 'Remove people or things: paint over them and the background is filled in.'
            : !eraser.ready
              ? 'Getting the eraser ready… you can start painting.'
              : strokes.length
                ? 'Press Erase (or Enter) when everything you want gone is covered.'
                : 'Paint over what you want to remove. [ and ] change the brush size.'

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
            {comparing && before && (
              <>
                <img className="erase-before" src={before.url} alt="" draggable={false} />
                <span className="erase-badge">Before</span>
              </>
            )}
            <div
              className={`crop-box${erasingMode ? ' passive' : ''}`}
              style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
              onPointerDown={erasingMode ? undefined : onDown('move')}
            >
              <div className="crop-grid" />
              {!erasingMode && HANDLES.map((h) => <span key={h} className={`crop-handle ${h}`} onPointerDown={onDown(h)} />)}
            </div>
            {erasingMode && !comparing && (
              <>
                <canvas
                  ref={paintRef}
                  className={`erase-layer${erasing ? ' working' : ''}`}
                  onPointerDown={onPaintDown}
                  onPointerMove={onPaintMove}
                  onPointerUp={onPaintUp}
                  onPointerCancel={onPaintUp}
                  onPointerLeave={() => setCursor(null)}
                />
                {cursor && !erasing && <span className="erase-cursor" style={{ left: cursor.x, top: cursor.y, width: brush, height: brush }} />}
              </>
            )}
          </div>
        ) : null}
        {(busy || erasing) && !error && (
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
                  <button
                    key={key}
                    className={`chip${aspect === key ? ' active' : ''}`}
                    onClick={() => {
                      chooseTool('crop')
                      chooseAspect(key)
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="edit-hint">Drag the frame's corners or edges on the photo to crop.</p>
            </>,
          )}
          {section(
            'Magic eraser',
            <>
              <button
                className={`btn enhance${tool === 'erase' ? ' on' : ''}`}
                disabled={!canErase}
                onClick={() => chooseTool(tool === 'erase' ? 'crop' : 'erase')}
                title="Paint over people or things to remove them"
              >
                <Brush size={16} /> Brush
                {tool === 'erase' && <Check size={15} />}
              </button>
              {tool === 'erase' && canErase && (
                <>
                  <label className="edit-slider">
                    <span>
                      Brush size
                      <b>{brush}</b>
                    </span>
                    <input type="range" min={BRUSH_MIN} max={BRUSH_MAX} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
                  </label>
                  <div className="edit-row erase-actions">
                    <button className="btn primary" disabled={!strokes.length || erasing} onClick={runErase} title="Fill in the painted area (Enter)">
                      {erasing ? <LoaderCircle size={15} className="spin" /> : <Eraser size={15} />} Erase
                    </button>
                    <button className="btn ghost" disabled={!strokes.length || erasing} onClick={() => setStrokes([])} title="Clear the paint (Esc)">
                      Clear
                    </button>
                  </div>
                </>
              )}
              {recipe.erase.length > 0 && (
                <div className="edit-row erase-actions">
                  <button className="btn ghost" disabled={erasing} onClick={undoErase} title="Undo the last erase (Ctrl+Z while painting)">
                    <Undo2 size={15} /> Undo erase
                  </button>
                  <button
                    className={`btn ghost${comparing ? ' on' : ''}`}
                    onPointerDown={() => setComparing(true)}
                    onPointerUp={() => setComparing(false)}
                    onPointerLeave={() => setComparing(false)}
                    onKeyDown={(e) => e.key === ' ' && setComparing(true)}
                    onKeyUp={() => setComparing(false)}
                    title="Hold to see the photo before erasing"
                  >
                    <SquareSplitHorizontal size={15} /> Compare
                  </button>
                </div>
              )}
              {eraserHint && <p className="edit-hint">{eraserHint}</p>}
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
            disabled={!changed(recipe) || erasing}
            onClick={reset}
            title="Undo all changes (Ctrl+Z)"
          >
            <Undo2 size={15} /> Reset
          </button>
          <div className="spacer" />
          <button className="btn primary" disabled={!changed(recipe) || saving || erasing || !!error} onClick={save} title="Save as a new copy (Ctrl+S)">
            {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Save copy
          </button>
        </div>
        <p className="edit-note">Saved as a new file next to the original — your original is never changed.</p>
      </aside>

      {confirmReset && (
        <div className="modal-backdrop" onMouseDown={() => setConfirmReset(false)}>
          <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <h3>Undo all changes?</h3>
            <p>
              Every change goes, including {recipe.erase.length === 1 ? 'the magic eraser step' : `all ${recipe.erase.length} magic eraser steps`}. To take back only the last erase, use Undo erase.
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmReset(false)} autoFocus>
                Keep editing
              </button>
              <button className="btn danger" onClick={resetAll}>
                Undo all
              </button>
            </div>
          </div>
        </div>
      )}
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
