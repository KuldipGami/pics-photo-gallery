import { EyeOff, FolderLock, KeyRound, LoaderCircle, Lock, LockKeyhole, ScanFace, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { formatCount } from '../lib/format'
import { useDialogKeys } from './PersonDialogs'
import './private.css'

/**
 * Private: the lock screen, the strip shown on the unlocked Private page, the PIN dialog and the
 * texts for the confirm dialogs. Props-driven: the main process (electron/private.cjs) does the
 * checking; these components only talk to it through `bridge`.
 */

// ---------- data (same shapes as electron/private.cjs) ----------

/** Windows Hello on this PC ('available' = face, fingerprint or Windows PIN can unlock). */
export type HelloState = 'available' | 'no-device' | 'not-set-up' | 'disabled' | 'busy' | 'unsupported'

export interface PrivateStatus {
  unlocked: boolean
  /** Undefined while Lumen is still asking Windows. */
  hello?: HelloState
  /** A Lumen PIN is set (the fallback when Windows Hello isn't set up). */
  hasPin: boolean
  /** Too many wrong PINs: wait this long. */
  waitMs: number
}

export interface UnlockResult {
  ok: boolean
  /** Windows Hello: 'canceled' | 'not-set-up' | 'no-device' | 'disabled' | 'busy' | 'too-many-tries' | 'error' */
  reason?: string
  error?: string
  waitMs?: number
}

/** Wire to the private:* IPC handlers. */
export interface PrivateBridge {
  status(): Promise<PrivateStatus>
  unlockHello(): Promise<UnlockResult>
  unlockPin(pin: string): Promise<UnlockResult>
  setPin(pin: string): Promise<{ ok: boolean; error?: string }>
  lock(): Promise<void>
  onStatus(cb: (status: PrivateStatus) => void): () => void
}

const HELLO_WHY: Record<HelloState, string> = {
  available: '',
  'no-device': "Windows Hello isn't set up on this PC",
  'not-set-up': "Windows Hello isn't set up for your account",
  disabled: 'Windows Hello is turned off by your organization',
  busy: 'Windows Hello is busy right now',
  unsupported: "Windows Hello can't be used here",
}

const HELLO_FAIL: Record<string, string> = {
  canceled: 'Cancelled. Try again when you are ready.',
  'not-set-up': "Windows Hello isn't set up for your account.",
  'no-device': "Windows Hello isn't available on this PC.",
  disabled: 'Windows Hello is turned off by your organization.',
  busy: 'Windows Hello is busy. Try again in a moment.',
  'too-many-tries': 'Too many tries. Windows asks you to wait before trying again.',
  error: "Windows Hello didn't answer. Try again.",
}

/** One sentence that's honest about what Private does (also for Settings / help). */
export const PRIVATE_EXPLAINER =
  "Private hides photos and videos inside Lumen: they don't show in Photos, albums, search, People, Places or anywhere else here. They are still ordinary files, so File Explorer and other apps can open them, unless you move them into Lumen's hidden private folder."

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000))

// ---------- lock screen ----------

export interface PrivateLockProps {
  /** null while loading. */
  status: PrivateStatus | null
  bridge: PrivateBridge
  /** "Forgot PIN": everything private shows in the library again (the app moves files out of the hidden folder first). */
  onReset?(): void
}

export function PrivateLock({ status, bridge, onReset }: PrivateLockProps) {
  const [mode, setMode] = useState<'hello' | 'pin' | 'setup' | 'forgot'>('hello')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [waitUntil, setWaitUntil] = useState(0)
  const [, tick] = useState(0)

  const hello = status?.hello
  const helloOk = hello === 'available'
  const checking = !status || hello === undefined

  // Pick the right screen once Windows has answered.
  useEffect(() => {
    if (!status || status.hello === undefined) return
    setMode((m) => (m === 'forgot' ? m : status.hello === 'available' ? (m === 'pin' && status.hasPin ? 'pin' : 'hello') : status.hasPin ? 'pin' : 'setup'))
  }, [status?.hello, status?.hasPin])

  useEffect(() => {
    if (status?.waitMs) setWaitUntil(Date.now() + status.waitMs)
  }, [status?.waitMs])
  const waitLeft = waitUntil - Date.now()
  useEffect(() => {
    if (waitLeft <= 0) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [waitLeft > 0])

  const unlockHello = async () => {
    setBusy(true)
    setError('')
    const r = await bridge.unlockHello().catch(() => ({ ok: false, reason: 'error' }) as UnlockResult)
    setBusy(false)
    if (!r.ok) setError(HELLO_FAIL[r.reason ?? 'error'] ?? HELLO_FAIL.error)
  }

  if (checking) {
    return (
      <div className="priv-lock">
        <div className="priv-card">
          <LockIcon />
          <h2>Private</h2>
          <p className="priv-wait">
            <LoaderCircle size={15} className="spin" /> Checking Windows Hello…
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="priv-lock">
      <div className="priv-card">
        <LockIcon />
        <h2>Private</h2>

        {mode === 'hello' && (
          <>
            <p>Your private photos and videos are locked. Unlock with your face, fingerprint or Windows PIN.</p>
            <button className="btn primary large priv-main" onClick={unlockHello} disabled={busy}>
              {busy ? <LoaderCircle size={17} className="spin" /> : <ScanFace size={17} />}
              {busy ? 'Waiting for Windows Hello…' : 'Unlock with Windows Hello'}
            </button>
            {error && <div className="priv-error">{error}</div>}
            {status.hasPin && (
              <button className="link priv-alt" onClick={() => setMode('pin')}>
                Use your Lumen PIN instead
              </button>
            )}
          </>
        )}

        {mode === 'pin' && (
          <>
            <p>Enter your Lumen PIN to see your private photos and videos.</p>
            <PinForm
              key="unlock"
              submitLabel="Unlock"
              disabled={waitLeft > 0}
              notice={waitLeft > 0 ? `Too many wrong PINs. Try again in ${seconds(waitLeft)} s.` : ''}
              onSubmit={async (pin) => {
                const r = await bridge.unlockPin(pin)
                if (r.waitMs) setWaitUntil(Date.now() + r.waitMs)
                return r.ok ? '' : (r.error ?? 'Wrong PIN.')
              }}
            />
            {helloOk && (
              <button className="link priv-alt" onClick={() => setMode('hello')}>
                Use Windows Hello instead
              </button>
            )}
            {!helloOk && onReset && (
              <button className="link priv-alt" onClick={() => setMode('forgot')}>
                Forgot your PIN?
              </button>
            )}
          </>
        )}

        {mode === 'setup' && (
          <>
            <p>
              {HELLO_WHY[hello ?? 'unsupported']}, so Private uses a PIN of its own. Choose one you'll remember: there's no way to see private items
              without it.
            </p>
            <PinForm
              key="setup"
              confirm
              submitLabel="Set PIN and unlock"
              onSubmit={async (pin) => {
                const r = await bridge.setPin(pin)
                return r.ok ? '' : (r.error ?? "That PIN can't be used.")
              }}
            />
            <p className="priv-small">
              To use your face, fingerprint or Windows PIN instead, set up Windows Hello in Windows Settings → Accounts → Sign-in options, then come
              back here.
            </p>
          </>
        )}

        {mode === 'forgot' && (
          <>
            <p>
              Lumen can't show private items without your PIN. Resetting forgets the PIN and every private mark, so all your private photos and videos
              show up in your library again (files in the hidden private folder are moved back to where they were).
            </p>
            <div className="priv-row">
              <button className="btn ghost" onClick={() => setMode('pin')}>
                Back
              </button>
              <button className="btn danger" onClick={onReset}>
                Reset Private
              </button>
            </div>
          </>
        )}

        <div className="priv-explainer">
          <EyeOff size={15} />
          <span>{PRIVATE_EXPLAINER}</span>
        </div>
      </div>
    </div>
  )
}

function LockIcon() {
  return (
    <span className="priv-lock-icon">
      <LockKeyhole size={30} strokeWidth={1.75} />
    </span>
  )
}

/** PIN entry (and repeat, when choosing one). `onSubmit` resolves to an error message, or '' when it worked. */
function PinForm({
  submitLabel,
  confirm = false,
  disabled = false,
  notice = '',
  onSubmit,
  onCancel,
}: {
  submitLabel: string
  confirm?: boolean
  disabled?: boolean
  notice?: string
  onSubmit(pin: string): Promise<string>
  /** In a dialog: a Cancel button next to the submit button. */
  onCancel?(): void
}) {
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || disabled || !pin) return
    if (confirm && pin !== again) {
      setError("The two PINs don't match.")
      return
    }
    setBusy(true)
    const message = await onSubmit(pin).catch(() => 'Something went wrong. Try again.')
    setBusy(false)
    setError(message)
    if (message) {
      setPin('')
      setAgain('')
      first.current?.focus()
    }
  }

  return (
    <form className="priv-pin" onSubmit={submit}>
      <div className="priv-field">
        <KeyRound size={15} />
        <input
          ref={first}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={32}
          placeholder={confirm ? 'New PIN (4 or more characters)' : 'PIN'}
          aria-label={confirm ? 'New PIN' : 'PIN'}
          value={pin}
          disabled={disabled}
          onChange={(e) => setPin(e.target.value)}
        />
      </div>
      {confirm && (
        <div className="priv-field">
          <KeyRound size={15} />
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={32}
            placeholder="Repeat the PIN"
            aria-label="Repeat the PIN"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </div>
      )}
      {(notice || error) && <div className="priv-error">{notice || error}</div>}
      {onCancel ? (
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !pin || !again}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />} {submitLabel}
          </button>
        </div>
      ) : (
        <button type="submit" className="btn primary priv-main" disabled={busy || disabled || !pin || (confirm && !again)}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Lock size={15} />} {submitLabel}
        </button>
      )}
    </form>
  )
}

// ---------- unlocked page ----------

export interface PrivateBarProps {
  /** Private items. */
  count: number
  /** How many of them are not in the hidden private folder yet (still visible in File Explorer). */
  visibleInExplorer: number
  onLock(): void
  /** Move those into the hidden private folder (confirm first: privateConfirm('hide', …)). */
  onHideInExplorer?(): void
  /** "Set up a PIN" / "Change PIN…" (PinDialog). */
  onPin?(): void
  hasPin?: boolean
}

/** The strip at the top of the unlocked Private page. */
export function PrivateBar({ count, visibleInExplorer, onLock, onHideInExplorer, onPin, hasPin }: PrivateBarProps) {
  return (
    <div className="priv-bar">
      <span className="priv-bar-icon">
        <LockKeyhole size={16} />
      </span>
      <div className="priv-bar-text">
        <div>
          Unlocked until you close Lumen or lock it.
          {count > 0 && visibleInExplorer === 0 && ' All of these are in the hidden private folder.'}
        </div>
        {visibleInExplorer > 0 && (
          <div className="priv-bar-sub">
            {visibleInExplorer === count ? (count === 1 ? 'This file is' : 'These files are') : `${formatCount(visibleInExplorer)} of these files are`} still visible
            in File Explorer and other apps.
          </div>
        )}
      </div>
      {visibleInExplorer > 0 && onHideInExplorer && (
        <button className="btn ghost" onClick={onHideInExplorer} title="Move them into a hidden folder inside your library folder (undo from History)">
          <FolderLock size={15} /> Hide in File Explorer
        </button>
      )}
      {onPin && (
        <button className="btn ghost" onClick={onPin}>
          <KeyRound size={15} /> {hasPin ? 'Change PIN' : 'Set a PIN'}
        </button>
      )}
      <button className="btn" onClick={onLock} title="Lock Private now">
        <Lock size={15} /> Lock
      </button>
    </div>
  )
}

/** Unlocked, nothing private yet. */
export function PrivateEmpty() {
  return (
    <div className="priv-lock">
      <div className="priv-card">
        <span className="priv-lock-icon">
          <EyeOff size={30} strokeWidth={1.75} />
        </span>
        <h2>Nothing private yet</h2>
        <p>
          Select photos or videos anywhere in Lumen and choose <b>Move to Private</b> (or right-click them). They'll only show here, behind the lock.
        </p>
        <div className="priv-explainer">
          <ShieldAlert size={15} />
          <span>
            Private hides files inside Lumen only. To also hide them in File Explorer, use <b>Hide in File Explorer</b> once they're here.
          </span>
        </div>
      </div>
    </div>
  )
}

/** Set or change the Lumen PIN (Private must be unlocked to change it). */
export function PinDialog({ bridge, hasPin, onClose, onDone }: { bridge: PrivateBridge; hasPin: boolean; onClose(): void; onDone?(): void }) {
  useDialogKeys((e) => {
    if (e.key === 'Escape') onClose()
  })
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal priv-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{hasPin ? 'Change your Lumen PIN' : 'Set a Lumen PIN'}</h3>
        <p>
          {hasPin
            ? 'The new PIN replaces the old one.'
            : 'A PIN of its own lets you open Private when Windows Hello is unavailable. Windows Hello keeps working as well.'}
        </p>
        <PinForm
          confirm
          submitLabel={hasPin ? 'Change PIN' : 'Set PIN'}
          onSubmit={async (pin) => {
            const r = await bridge.setPin(pin)
            if (r.ok) {
              onDone?.()
              onClose()
              return ''
            }
            return r.error ?? "That PIN can't be used."
          }}
          onCancel={onClose}
        />
      </div>
    </div>
  )
}

// ---------- confirm texts ----------

export type PrivateAction = 'add' | 'remove' | 'hide' | 'unhide' | 'reset'

const things = (n: number) => `${formatCount(n)} ${n === 1 ? 'item' : 'items'}`

/** Texts for the app's ConfirmDialog. `folder`: the hidden folder ("…\Lumen Private") for 'hide'. */
export function privateConfirm(action: PrivateAction, count: number, extra: { folder?: string } = {}): { title: string; message: string; confirmLabel: string; danger?: boolean; warning?: string } {
  switch (action) {
    case 'add':
      return {
        title: `Move ${things(count)} to Private?`,
        message:
          "They'll disappear from Photos, albums, search, People, Places, Memories and Clean up, and only show on the Private page after you unlock it. The files themselves aren't moved or changed.",
        confirmLabel: 'Move to Private',
        warning: 'They are still ordinary files in File Explorer. To hide them there too, use "Hide in File Explorer" on the Private page.',
      }
    case 'remove':
      return {
        title: `Remove ${things(count)} from Private?`,
        message: "They'll show in your library again, everywhere in Lumen. Files in the hidden private folder are moved back to where they were.",
        confirmLabel: 'Remove from Private',
      }
    case 'hide':
      return {
        title: `Hide ${things(count)} in File Explorer?`,
        message: `They're moved into a hidden "Lumen Private" folder inside your library folder${extra.folder ? ` (${extra.folder})` : ''}, keeping their sub-folders. File Explorer doesn't show hidden folders unless "Hidden items" is turned on. You can undo this from History.`,
        confirmLabel: 'Hide in File Explorer',
        warning: "This isn't encryption: anyone using this PC who shows hidden items, and apps that sync or back up the folder (like OneDrive), can still see them.",
      }
    case 'unhide':
      return {
        title: `Move ${things(count)} out of the hidden folder?`,
        message: "They go back to the folders they came from and show in File Explorer again. They stay private in Lumen.",
        confirmLabel: 'Move back',
      }
    case 'reset':
      return {
        title: 'Reset Private?',
        message: 'The PIN is forgotten and every private photo and video shows in your library again. Files in the hidden private folder are moved back to where they were.',
        confirmLabel: 'Reset Private',
        danger: true,
      }
  }
}
