import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  onClick(): void
}

/**
 * A small dropdown menu attached to any trigger. Rendered at the top level (portal) and kept
 * inside the window, so it never gets clipped by — or scrolls — narrow panels.
 */
export function PopoverMenu({
  trigger,
  items,
  align = 'right',
  dark = false,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  /** Dark styling, for menus inside the photo viewer. */
  dark?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current || !menu.current) return setPos(null)
    const a = anchor.current.getBoundingClientRect()
    const { offsetWidth: w, offsetHeight: h } = menu.current
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, align === 'left' ? a.left : a.right - w))
    let top = a.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6)
    setPos({ top, left })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!anchor.current?.contains(t) && !menu.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const close = () => setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [open])

  return (
    <div className="popover-anchor" ref={anchor}>
      {trigger(open, () => setOpen((o) => !o))}
      {open &&
        createPortal(
          <div
            ref={menu}
            className={`popover-menu${dark ? ' dark' : ''}`}
            role="menu"
            style={pos ?? { top: 0, left: 0, visibility: 'hidden' }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className={`popover-item${item.danger ? ' danger' : ''}`}
                onClick={() => {
                  setOpen(false)
                  item.onClick()
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
