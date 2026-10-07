import { FolderPlus } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  onConfirm(): void
}

export function ConfirmDialog({ options, onClose }: { options: ConfirmOptions; onClose(): void }) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
    // Capture phase so the viewer / grid shortcuts don't also react.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter') {
        e.preventDefault()
        options.onConfirm()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [options, onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{options.title}</h3>
        <p>{options.message}</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={`btn ${options.danger ? 'danger' : 'primary'}`}
            onClick={() => {
              options.onConfirm()
              onClose()
            }}
          >
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function Toasts({ toasts }: { toasts: { id: number; text: string }[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
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
