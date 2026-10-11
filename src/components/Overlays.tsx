import { FolderPlus, TriangleAlert } from 'lucide-react'
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Toast } from '../hooks'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  /** Shown in an amber box. */
  warning?: string
  /** Extra content between the message and the buttons (e.g. a destination folder). */
  extra?: ReactNode
  /** Shows a "Don't ask again" box; called (before onConfirm) when confirming with it ticked. */
  dontAskAgain?(): void
  onConfirm(): void
}

export function ConfirmDialog({ options, onClose }: { options: ConfirmOptions; onClose(): void }) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // The latest props, so the key listener isn't re-installed (and focus isn't moved) on every App render.
  const [dontAsk, setDontAsk] = useState(false)
  const latest = useRef({ options, onClose, dontAsk })
  latest.current = { options, onClose, dontAsk }
  const confirm = () => {
    const { options, onClose, dontAsk } = latest.current
    if (dontAsk) options.dontAskAgain?.()
    options.onConfirm()
    onClose()
  }

  // Focus the confirm button once, when the dialog opens.
  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  useEffect(() => {
    // Capture phase so the viewer / grid shortcuts don't also react.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      const { onClose } = latest.current
      const target = e.target as HTMLElement | null
      const inside = !!target && !!dialogRef.current?.contains(target)
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Enter') {
        // a held Enter (from whatever opened the dialog) answers nothing
        if (e.repeat) return e.preventDefault()
        // A focused button in the dialog (Cancel, "Change…") does its own thing
        if (inside && target?.closest('button')) return
        e.preventDefault()
        confirm()
      } else if (e.key === ' ' && !inside) e.preventDefault() // never a button behind the dialog
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{options.title}</h3>
        <p>{options.message}</p>
        {options.extra}
        {options.warning && <div className="modal-warning">{options.warning}</div>}
        {options.dontAskAgain && (
          <label className="modal-check">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            Don't ask again
          </label>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={`btn ${options.danger ? 'danger' : 'primary'}`}
            onClick={confirm}
          >
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss?(id: number): void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.error ? ' error' : ''}${t.action ? ' has-action' : ''}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run()
                onDismiss?.(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode
  title: string
  text: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  )
}

/** A short message with Reload instead of a blank window, should the page hit an error it can't get past. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <div className="crash-drag" />
        <EmptyState
          icon={<TriangleAlert size={40} strokeWidth={1.5} />}
          title="Something went wrong"
          text="Pics ran into a problem showing this page. Your photos and files are fine: reload to carry on."
          action={
            <button className="btn primary large" onClick={() => window.location.reload()}>
              Reload
            </button>
          }
        />
      </div>
    )
  }
}

export function DropOverlay() {
  return (
    <div className="drop-overlay">
      <div className="drop-card">
        <FolderPlus size={34} />
        <div>Drop a folder to add it to your library</div>
      </div>
    </div>
  )
}
