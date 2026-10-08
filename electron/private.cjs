const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { keyOf } = require('./library.cjs')
const { uniquePath, moveFile } = require('./cleanup.cjs')
const { writeAtomic, writeAtomicSync, readJson } = require('./safe-file.cjs')

/**
 * Private: photos and videos marked private disappear from every view and only show on the
 * Private page, which unlocks with Windows Hello (face, fingerprint or Windows PIN) or, where
 * Windows Hello isn't set up, a Pics PIN. Unlocked until Pics closes or is locked again.
 *
 * Honest limits (said in the UI too): this hides files inside Pics. They stay normal files in
 * File Explorer unless moved into the hidden private folder ("<library folder>\Pics Private",
 * hidden attribute), and even then anyone who shows hidden items in Explorer can open them.
 *
 * private.json (userData) stores no file names: each private file is a salted hash of its path.
 * The Pics PIN is stored as a salted scrypt hash. Files inside a "Pics Private" folder at the
 * top of a library folder are always private.
 */

const VAULT = 'Pics Private'
/** What the hidden folder was called before Pics was renamed (1.16): one that exists is still used. */
const LEGACY_VAULT = 'Lumen Private'
const PIN_MIN = 4
const PIN_MAX = 32
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }
const FREE_TRIES = 5

// UserConsentVerifierAvailability / UserConsentVerificationResult (WinRT enums)
const AVAILABILITY = ['available', 'no-device', 'not-set-up', 'disabled', 'busy']
const RESULT = ['verified', 'no-device', 'not-set-up', 'disabled', 'busy', 'too-many-tries', 'canceled']

const scrypt = (pin, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(String(pin).normalize('NFC'), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  )

const trimSep = (p) => p.replace(/[\\/]+$/, '')
/**
 * A library folder as a directory to join paths onto: no trailing separator, except a drive root
 * keeps its own ("D:\", not "D:", which Windows reads as "the current folder on drive D").
 */
/** The hidden folder's name in a library folder: "Lumen Private" where that one exists, else "Pics Private". */
const vaultName = (root) => (fs.existsSync(path.join(root, LEGACY_VAULT)) ? LEGACY_VAULT : VAULT)

const rootDir = (r) => {
  const t = trimSep(r)
  if (!t) return r
  return /^[a-z]:$/i.test(t) ? t + path.sep : t
}

class PrivateFolder extends EventEmitter {
  /**
   * @param {string} file private.json
   * @param {{ roots?: () => string[], dataDir?: string, hello?: HelloBridge, now?: () => number, count?: () => number }} [opts]
   *   roots: the library folders (each gets its own hidden "Pics Private" folder when used).
   *   dataDir: where the Windows Hello helper script (private-agent.ps1) is written: pass userData
   *   (default: the folder of `file`).
   *   count: how many library items are private now (default: how many files are marked).
   */
  constructor(file, { roots = () => [], dataDir = path.dirname(file), hello, now = Date.now, count } = {}) {
    super()
    this.file = file
    this.roots = roots
    this.now = now
    this.countItems = count ?? (() => this.hashes.size)
    this.hello = hello ?? new HelloBridge({ dir: dataDir })
    this.salt = crypto.randomBytes(16).toString('hex')
    this.hashes = new Set()
    this.pin = null // { salt, hash }
    this.failed = 0
    this.blockedUntil = 0
    this.unlocked = false
    /** Windows Hello has unlocked Private before: then it's the key, and a first PIN can't be set while locked. */
    this.helloUsed = false
    this.memo = new Map() // keyOf(path) → hash
    this.itemKeys = new WeakMap() // library item → { path, key, hash }
    this.timer = null
    // PIN attempts run one at a time, so attempts made together can't all skip the lockout.
    this.pinTurn = Promise.resolve()
    // private.json exists but couldn't be read: never saved over this session (it holds the PIN).
    this.readOnly = false
  }

  async load() {
    const res = await readJson(this.file)
    if (res.corrupt) console.error(`private.json was damaged; kept as ${res.keptAs ?? '(could not move it)'}`)
    if (res.error) {
      this.readOnly = true
      console.error("Couldn't read private.json; it won't be saved this session", res.error)
    }
    const data = res.data
    if (!data || data.version !== 1) return
    if (typeof data.salt === 'string') this.salt = data.salt
    if (Array.isArray(data.items)) this.hashes = new Set(data.items.filter((h) => typeof h === 'string'))
    if (data.pin && typeof data.pin.salt === 'string' && typeof data.pin.hash === 'string') this.pin = data.pin
    this.failed = Number(data.failed) || 0
    this.blockedUntil = Number(data.blockedUntil) || 0
    this.helloUsed = data.helloUsed === true
  }

  saveSoon() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), 200)
  }

  saveNow() {
    clearTimeout(this.timer)
    this.timer = null
    if (this.readOnly) return
    try {
      const data = { version: 1, salt: this.salt, items: [...this.hashes], pin: this.pin, failed: this.failed, blockedUntil: this.blockedUntil, helloUsed: this.helloUsed }
      writeAtomicSync(this.file, JSON.stringify(data))
    } catch (err) {
      console.error('Failed to save private.json', err)
    }
  }

  // ── which files are private ───────────────────────────────────────────────

  hashOf(p) {
    return this.hashKey(keyOf(trimSep(p)))
  }

  /** Hash of an already normalised key (keyOf, no trailing separator). Remembered per path. */
  hashKey(key) {
    let h = this.memo.get(key)
    if (!h) {
      h = crypto.createHash('sha256').update(this.salt).update(key).digest('hex').slice(0, 32)
      if (this.memo.size > 200_000) this.memo.clear()
      this.memo.set(key, h)
    }
    return h
  }

  /** "<library folder>\lumen private\" keys of every library folder. */
  vaultKeys() {
    return this.roots().flatMap((r) => [VAULT, LEGACY_VAULT].map((name) => keyOf(path.join(rootDir(r), name)) + path.sep))
  }

  /** The library folder a path is in (the longest match), or null. A drive root comes back as "D:\". */
  rootOf(p) {
    const key = keyOf(trimSep(p))
    let best = null
    let bestKey = ''
    for (const r of this.roots()) {
      const rk = keyOf(trimSep(r))
      if (!rk) continue
      if ((key.startsWith(rk + path.sep) || key === rk) && (!best || rk.length > bestKey.length)) {
        best = rootDir(r)
        bestKey = rk
      }
    }
    return best
  }

  /** Inside a "<library folder>\Pics Private" folder. */
  inVault(p) {
    const key = keyOf(p)
    return this.vaultKeys().some((v) => key.startsWith(v))
  }

  isPrivate(p) {
    return typeof p === 'string' && (this.hashes.has(this.hashOf(p)) || this.inVault(p))
  }

  /**
   * Splits library items into { shown, hidden } (hidden = private). Runs on every library change:
   * a few ms for 15,000 items once their hashes are remembered. With nothing private, `shown` is
   * `items` itself.
   */
  split(items) {
    const vaults = this.vaultKeys()
    const marks = this.hashes.size > 0
    if (!marks && !items.some((it) => vaults.some((v) => keyOf(it.path).startsWith(v)))) return { shown: items, hidden: [] }
    const shown = []
    const hidden = []
    for (const it of items) {
      let k = this.itemKeys.get(it)
      if (!k || k.path !== it.path) {
        const key = keyOf(it.path)
        k = { path: it.path, key, hash: this.hashKey(key) }
        this.itemKeys.set(it, k)
      }
      if ((marks && this.hashes.has(k.hash)) || vaults.some((v) => k.key.startsWith(v))) hidden.push(it)
      else shown.push(it)
    }
    return { shown, hidden }
  }

  /** Marks paths private. Returns how many weren't already. */
  add(paths) {
    let n = 0
    for (const p of paths) {
      if (typeof p !== 'string') continue
      const h = this.hashOf(p)
      if (!this.hashes.has(h)) {
        this.hashes.add(h)
        n++
      }
    }
    if (n) this.changed()
    return n
  }

  /** Un-marks paths (files inside the hidden folder stay private until moved out). */
  remove(paths) {
    let n = 0
    for (const p of paths) if (typeof p === 'string' && this.hashes.delete(this.hashOf(p))) n++
    if (n) this.changed()
    return n
  }

  /** Files Pics moved or renamed ([{ from, to }]): their private mark follows them. */
  remap(pairs) {
    let n = 0
    for (const { from, to } of pairs) {
      if (typeof from !== 'string' || typeof to !== 'string') continue
      if (this.hashes.delete(this.hashOf(from))) {
        this.hashes.add(this.hashOf(to))
        n++
      }
    }
    if (n) this.changed()
    return n
  }

  changed() {
    this.saveSoon()
    this.emit('changed')
  }

  // ── lock ─────────────────────────────────────────────────────────────────

  /** How many items are private (0 when that can't be told). */
  count() {
    try {
      return Math.max(0, Number(this.countItems()) || 0)
    } catch {
      return this.hashes.size
    }
  }

  /**
   * What the lock screen needs. `hello` is undefined until checked (call checkHello()); `count` is
   * how many items are private.
   */
  status() {
    const wait = Math.max(0, this.blockedUntil - this.now())
    return { unlocked: this.unlocked, hello: this.helloState, hasPin: !!this.pin, waitMs: wait, count: this.count(), canSetup: this.canSetup() }
  }

  /**
   * Can a first PIN be chosen while locked? Yes when nothing is private yet, or when Windows Hello
   * has never unlocked Private (no key was ever set up, so there's nothing to get round). Once Hello
   * is the key, a glitch in the Hello check must not let anyone set a PIN and walk in.
   */
  canSetup() {
    return !this.pin && (this.count() === 0 || !this.helloUsed)
  }

  lock() {
    if (!this.unlocked) return
    this.unlocked = false
    this.emit('status', this.status())
  }

  unlock() {
    this.unlocked = true
    this.failed = 0
    this.blockedUntil = 0
    this.saveSoon()
    this.emit('status', this.status())
  }

  /** 'available' | 'no-device' | 'not-set-up' | 'disabled' | 'busy' | 'unsupported' (not Windows / no PowerShell). */
  async checkHello() {
    if (process.platform !== 'win32') this.helloState = 'unsupported'
    else {
      try {
        const n = await this.hello.availability()
        this.helloState = AVAILABILITY[n] ?? 'unsupported'
      } catch {
        this.helloState = 'unsupported'
      }
    }
    this.emit('status', this.status())
    return this.helloState
  }

  /**
   * Shows the Windows Hello prompt (owned by `hwnd`, Pics' window, so it opens in front of it).
   * Resolves to { ok, reason? } where reason is a RESULT value or 'error'.
   */
  async unlockWithHello(hwnd, message = 'Unlock Private in Pics') {
    try {
      const { result } = await this.hello.verify(hwnd, message)
      const reason = RESULT[result] ?? 'error'
      if (reason === 'verified') {
        this.helloUsed = true
        this.unlock()
        return { ok: true }
      }
      return { ok: false, reason }
    } catch (err) {
      return { ok: false, reason: 'error', error: String(err?.message ?? err) }
    }
  }

  /**
   * Resolves to { ok } or { ok: false, error, waitMs? }. Wrong PINs make you wait (30 s, doubling up
   * to 5 min). Attempts take turns: each one checks the wait only after the one before it counted.
   */
  unlockWithPin(pin) {
    const attempt = this.pinTurn.then(() => this.tryPin(pin))
    this.pinTurn = attempt.catch(() => {})
    return attempt
  }

  async tryPin(pin) {
    if (!this.pin) return { ok: false, error: 'No PIN has been set.' }
    const wait = this.blockedUntil - this.now()
    if (wait > 0) return { ok: false, error: `Too many wrong PINs. Try again in ${Math.ceil(wait / 1000)} seconds.`, waitMs: wait }
    const key = await scrypt(pin, Buffer.from(this.pin.salt, 'hex'))
    const want = Buffer.from(this.pin.hash, 'hex')
    if (key.length === want.length && crypto.timingSafeEqual(key, want)) {
      this.unlock()
      return { ok: true }
    }
    this.failed++
    if (this.failed >= FREE_TRIES) {
      const ms = Math.min(5 * 60_000, 30_000 * 2 ** (this.failed - FREE_TRIES))
      this.blockedUntil = this.now() + ms
      this.saveNow()
      this.emit('status', this.status())
      return { ok: false, error: `Wrong PIN. Too many tries: wait ${Math.round(ms / 1000)} seconds.`, waitMs: ms }
    }
    this.saveSoon()
    const left = FREE_TRIES - this.failed
    return { ok: false, error: `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before a short wait.` }
  }

  /** Sets (or changes) the Pics PIN. Allowed while unlocked, or for a first PIN when canSetup(). */
  async setPin(pin) {
    if (this.pin && !this.unlocked) return { ok: false, error: 'Unlock Private first.' }
    if (!this.pin && !this.unlocked && !this.canSetup()) return { ok: false, error: 'Unlock Private first.' }
    const s = String(pin ?? '')
    if (s.length < PIN_MIN || s.length > PIN_MAX) return { ok: false, error: `Use ${PIN_MIN} to ${PIN_MAX} characters.` }
    if (/^(\d)\1+$/.test(s) || '0123456789012'.includes(s) || '9876543210987'.includes(s)) return { ok: false, error: 'That PIN is too easy to guess.' }
    const salt = crypto.randomBytes(16)
    const hash = await scrypt(s, salt)
    this.pin = { salt: salt.toString('hex'), hash: hash.toString('hex') }
    this.saveNow()
    if (!this.unlocked) this.unlock()
    else this.emit('status', this.status())
    return { ok: true }
  }

  /** Removes the Pics PIN (only while unlocked and when Windows Hello can unlock instead). */
  removePin() {
    if (!this.unlocked || this.helloState !== 'available') return false
    this.pin = null
    this.saveNow()
    this.emit('status', this.status())
    return true
  }

  /**
   * "Forgot PIN": forgets every private mark and the PIN, so everything shows in the library again
   * (Pics can't show private items without unlocking — this is the only way back in). Files in
   * the hidden folder must be moved out first (vaultItems + moveOutOfVault), or they stay private.
   */
  reset() {
    this.hashes.clear()
    this.pin = null
    this.failed = 0
    this.blockedUntil = 0
    this.saveNow()
    this.emit('changed')
    this.emit('status', this.status())
  }

  // ── the hidden private folder ─────────────────────────────────────────────

  /** "<library folder>\Pics Private" for a file, or null when the file isn't in a library folder. */
  vaultDirFor(file) {
    const root = this.rootOf(file)
    return root ? path.join(root, vaultName(root)) : null
  }

  /** Where a file goes in the hidden folder: its path relative to its library folder is kept. */
  vaultTarget(file) {
    const root = this.rootOf(file)
    if (!root) return null
    return path.join(root, vaultName(root), path.relative(root, file))
  }

  /** Where a file in the hidden folder came from. */
  originOf(file) {
    const root = this.rootOf(file)
    if (!root) return null
    for (const name of [VAULT, LEGACY_VAULT]) {
      const vault = path.join(root, name)
      if (keyOf(file).startsWith(keyOf(vault) + path.sep)) return path.join(root, path.relative(vault, file))
    }
    return null
  }

  vaultItems(items) {
    return items.filter((it) => this.inVault(it.path))
  }

  /**
   * Moves items into the hidden private folder (marked private first, so they stay private if
   * this is undone from History). Never overwrites. Resolves to { files: [{ id, from, to, size }],
   * errors: ["name: reason"], folders: [vault folders used] } — main.cjs adds a History entry
   * ({ kind: 'moved', destination, files }) and calls relocate(files).
   */
  async moveIntoVault(items) {
    const files = []
    const errors = []
    const folders = new Set()
    this.add(items.map((it) => it.path))
    for (const it of items) {
      if (this.inVault(it.path)) continue
      const target = this.vaultTarget(it.path)
      if (!target) {
        errors.push(`${it.name}: it isn't inside a library folder`)
        continue
      }
      try {
        const vault = this.vaultDirFor(it.path)
        if (!folders.has(vault)) {
          await fsp.mkdir(vault, { recursive: true })
          await hideFolder(vault)
          folders.add(vault)
        }
        await fsp.mkdir(path.dirname(target), { recursive: true })
        const to = uniquePath(target)
        await moveFile(it.path, to)
        files.push({ id: it.id, from: it.path, to, size: it.size })
      } catch (err) {
        errors.push(`${it.name}: ${err.message}`)
      }
    }
    this.remap(files)
    return { files, errors, folders: [...folders] }
  }

  /** Moves items out of the hidden folder back to where they came from (" (2)" when taken). Same result shape. */
  async moveOutOfVault(items) {
    const files = []
    const errors = []
    for (const it of items) {
      const origin = this.originOf(it.path)
      if (!origin) continue
      try {
        await fsp.mkdir(path.dirname(origin), { recursive: true })
        const to = uniquePath(origin)
        await moveFile(it.path, to)
        files.push({ id: it.id, from: it.path, to, size: it.size })
        await removeEmptyDirs(path.dirname(it.path), this.vaultDirFor(it.path))
      } catch (err) {
        errors.push(`${it.name}: ${err.message}`)
      }
    }
    this.remap(files)
    return { files, errors }
  }

  dispose() {
    if (this.timer) this.saveNow()
    this.hello.dispose()
  }
}

/** Sets the Windows "hidden" attribute on a folder (no-op elsewhere). */
function hideFolder(dir) {
  if (process.platform !== 'win32') return Promise.resolve()
  return new Promise((resolve) => {
    const p = spawn('attrib.exe', ['+h', dir], { windowsHide: true, stdio: 'ignore' })
    p.on('error', () => resolve())
    p.on('exit', () => resolve())
  })
}

/** Removes `dir` and its parents up to (and including) `stop` while they're empty. */
async function removeEmptyDirs(dir, stop) {
  if (!stop) return
  for (let d = dir; keyOf(d).startsWith(keyOf(stop)); d = path.dirname(d)) {
    try {
      if ((await fsp.readdir(d)).length) return
      await fsp.rmdir(d)
    } catch {
      return
    }
    if (keyOf(d) === keyOf(stop)) return
  }
}

// ── Windows Hello through PowerShell (WinRT UserConsentVerifier) ──────────

/*
 * PowerShell 5.1 compiles a little C# helper that calls the WinRT API through raw COM vtables (no
 * WinRT projection needed):
 *  - CheckAvailabilityAsync (IUserConsentVerifierStatics {AF4F3F91-564C-4DDC-B8B5-973447627C65})
 *  - RequestVerificationForWindowAsync(hwnd, message) (IUserConsentVerifierInterop
 *    {39E050C3-4E74-441A-8DC0-B81104DF949C}): the prompt is owned by Pics' window, so it opens in
 *    front of it instead of behind. If that fails, RequestVerificationAsync(message) is used and the
 *    prompt window ("Credential Dialog Xaml Host") is pulled to the front for a few seconds.
 * Async operations are awaited by polling IAsyncInfo.Status (MTA thread, so nothing needs a message
 * pump). The process starts when the lock screen shows (compiling takes ~0.3–1.3 s, PowerShell
 * itself ~1 s), answers availability right away and then waits for a verify command on stdin, so
 * clicking "Unlock" shows the prompt without that delay. It exits after 3 idle minutes.
 *
 * The script is written to <dir>private-agent.ps1 (UTF-8 with BOM, rewritten only when it changes)
 * and run with -File, like ocr.cjs: antivirus tools (Avast / AVG "IDP.HELU.PSE92") flag and kill
 * PowerShell started with -EncodedCommand.
 */
const HELLO_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class LumenHello {
  [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr cls, [In] ref Guid iid, out IntPtr factory);
  [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string s, int length, out IntPtr hstring);
  [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr hstring);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
  delegate int QI(IntPtr self, [In] ref Guid iid, out IntPtr obj);
  delegate uint Rel(IntPtr self);
  delegate int OutPtr(IntPtr self, out IntPtr result);
  delegate int OutInt(IntPtr self, out int result);
  delegate int NoArgs(IntPtr self);
  delegate int StrOutPtr(IntPtr self, IntPtr hstring, out IntPtr result);
  delegate int WindowStrOutPtr(IntPtr self, IntPtr hwnd, IntPtr hstring, [In] ref Guid riid, out IntPtr result);
  const string Class = "Windows.Security.Credentials.UI.UserConsentVerifier";
  static readonly Guid StaticsIid = new Guid("AF4F3F91-564C-4DDC-B8B5-973447627C65");
  static readonly Guid InteropIid = new Guid("39E050C3-4E74-441A-8DC0-B81104DF949C");
  static readonly Guid AsyncInfoIid = new Guid("00000036-0000-0000-C000-000000000046");
  static readonly Guid VerificationIid = new Guid("1A125473-B29C-520E-B0F2-2931207E99E2");
  static T Slot<T>(IntPtr obj, int index) {
    IntPtr vtbl = Marshal.ReadIntPtr(obj);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, index * IntPtr.Size), typeof(T));
  }
  static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
  static void Release(IntPtr p) { if (p != IntPtr.Zero) Slot<Rel>(p, 2)(p); }
  static IntPtr Factory(Guid iid) {
    IntPtr cls; Check(WindowsCreateString(Class, Class.Length, out cls));
    try { IntPtr f; Check(RoGetActivationFactory(cls, ref iid, out f)); return f; } finally { WindowsDeleteString(cls); }
  }
  static int Wait(IntPtr op, int timeoutMs, bool toFront) {
    Guid iid = AsyncInfoIid; IntPtr info;
    Check(Slot<QI>(op, 0)(op, ref iid, out info));
    try {
      DateTime until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
      int status, tries = 0;
      while (true) {
        Check(Slot<OutInt>(info, 7)(info, out status));
        if (status != 0) break;
        if (DateTime.UtcNow > until) { Slot<NoArgs>(info, 9)(info); throw new TimeoutException("No answer from Windows Hello"); }
        if (toFront && tries++ < 200) {
          IntPtr dlg = FindWindow("Credential Dialog Xaml Host", null);
          if (dlg != IntPtr.Zero && GetForegroundWindow() != dlg) SetForegroundWindow(dlg);
        }
        Thread.Sleep(25);
      }
      if (status == 2) return 6;
      if (status != 1) { int err; Slot<OutInt>(info, 8)(info, out err); Marshal.ThrowExceptionForHR(err); }
      int result; Check(Slot<OutInt>(op, 8)(op, out result));
      return result;
    } finally { Release(info); }
  }
  public static int Availability() {
    IntPtr f = Factory(StaticsIid);
    try { IntPtr op; Check(Slot<OutPtr>(f, 6)(f, out op)); try { return Wait(op, 15000, false); } finally { Release(op); } } finally { Release(f); }
  }
  public static string Verify(long hwnd, string message) {
    AllowSetForegroundWindow(-1);
    IntPtr hs; Check(WindowsCreateString(message, message.Length, out hs));
    try {
      IntPtr op = IntPtr.Zero; string how = "plain";
      if (hwnd != 0) {
        try {
          IntPtr f = Factory(InteropIid);
          try { Guid riid = VerificationIid; if (Slot<WindowStrOutPtr>(f, 6)(f, new IntPtr(hwnd), hs, ref riid, out op) < 0) op = IntPtr.Zero; else how = "window"; } finally { Release(f); }
        } catch { op = IntPtr.Zero; }
      }
      if (op == IntPtr.Zero) { IntPtr f = Factory(StaticsIid); try { Check(Slot<StrOutPtr>(f, 7)(f, hs, out op)); } finally { Release(f); } }
      try { return Wait(op, 180000, true) + " " + how; } finally { Release(op); }
    } finally { WindowsDeleteString(hs); }
  }
}`

const HELLO_PS = `
$ErrorActionPreference = 'Stop'
function Send($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try { Add-Type -TypeDefinition @'
${HELLO_CS}
'@ } catch { Send @{ ready = $false; error = $_.Exception.Message }; exit 1 }
try { Send @{ ready = $true; availability = [LumenHello]::Availability() } } catch { Send @{ ready = $true; availability = -1; error = $_.Exception.Message } }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $cmd = $line | ConvertFrom-Json } catch { continue }
  if ($cmd.op -eq 'exit') { break }
  try {
    if ($cmd.op -eq 'availability') { Send @{ id = $cmd.id; result = [LumenHello]::Availability() } }
    elseif ($cmd.op -eq 'verify') { $r = ([LumenHello]::Verify([long]$cmd.hwnd, [string]$cmd.message)).Split(' '); Send @{ id = $cmd.id; result = [int]$r[0]; how = $r[1] } }
  } catch { Send @{ id = $cmd.id; error = $_.Exception.Message } }
}`

const SCRIPT_NAME = 'private-agent.ps1'

function powershellExe() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(exe) ? exe : 'powershell.exe'
}

/** One PowerShell process that answers Windows Hello requests (see above). */
class HelloBridge {
  /** @param {{ dir?: string, powershell?: string, idleMs?: number }} [opts] dir: where private-agent.ps1 is kept (userData). */
  constructor({ dir = os.tmpdir(), powershell = powershellExe(), idleMs = 3 * 60_000 } = {}) {
    this.script = path.join(dir, SCRIPT_NAME)
    this.powershell = powershell
    this.idleMs = idleMs
    this.proc = null
    this.ready = null
    this.pending = new Map()
    this.nextId = 1
    this.idleTimer = null
    this.timings = {}
  }

  /** Writes private-agent.ps1 when it's missing or out of date (UTF-8 with BOM, so PowerShell 5.1 reads it right). */
  async ensureScript() {
    const source = '\ufeff' + HELLO_PS.replace(/\r?\n/g, '\r\n')
    const current = await fsp.readFile(this.script, 'utf8').catch(() => null)
    if (current === source) return
    await writeAtomic(this.script, source)
  }

  /** Starts PowerShell (if needed). Resolves to the availability number (-1 = unknown). */
  start() {
    if (this.ready) return this.ready
    const t0 = Date.now()
    this.ready = this.ensureScript().then(() => this.spawn(t0))
    this.ready.catch(() => {
      this.ready = null
    })
    this.touch()
    return this.ready
  }

  spawn(t0) {
    return new Promise((resolve, reject) => {
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-MTA', '-ExecutionPolicy', 'Bypass', '-File', this.script]
      const proc = spawn(this.powershell, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.proc = proc
      // Writing to a helper that just exited fails on the pipe (EPIPE): without a listener that
      // would be an uncaught exception. Its jobs are rejected by 'exit' below.
      proc.stdin.on('error', () => {})
      let buffer = ''
      let started = false
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => {
        buffer += chunk
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('{')) continue
          let msg
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (!started && 'ready' in msg) {
            started = true
            this.timings.startMs = Date.now() - t0
            if (msg.ready) resolve(Number.isInteger(msg.availability) ? msg.availability : -1)
            else reject(new Error(msg.error || 'Windows Hello helper failed to start'))
            continue
          }
          const job = this.pending.get(msg.id)
          if (!job) continue
          this.pending.delete(msg.id)
          clearTimeout(job.timer)
          if (msg.error) job.reject(new Error(msg.error))
          else job.resolve(msg)
        }
      })
      proc.stderr.on('data', () => {})
      proc.on('error', (err) => {
        if (!started) reject(err)
      })
      proc.on('exit', () => {
        if (!started) reject(new Error('Windows Hello helper exited'))
        // (only this process's jobs: a newer helper may already be answering others)
        for (const [id, job] of [...this.pending]) {
          if (job.proc !== proc) continue
          clearTimeout(job.timer)
          this.pending.delete(id)
          job.reject(new Error('Windows Hello helper exited'))
        }
        if (this.proc === proc) {
          this.proc = null
          this.ready = null
        }
      })
    })
  }

  touch() {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.pending.size) this.stop()
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  async send(op, extra, timeoutMs) {
    await this.start()
    this.touch()
    const id = this.nextId++
    const proc = this.proc
    return new Promise((resolve, reject) => {
      if (!proc || proc.exitCode !== null || !proc.stdin.writable) {
        reject(new Error('Windows Hello helper exited'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('No answer from Windows Hello'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, proc })
      proc.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n')
    })
  }

  /** UserConsentVerifierAvailability: 0 available, 1 no device, 2 not set up, 3 disabled by policy, 4 busy. */
  async availability() {
    if (!this.proc) return this.start()
    const res = await this.send('availability', {}, 20_000)
    return res.result
  }

  /**
   * Shows the Windows Hello prompt. `hwnd`: Pics' window handle (BigInt / number / decimal string,
   * from win.getNativeWindowHandle().readBigUInt64LE(0)) so the prompt belongs to that window.
   * Resolves to { result: UserConsentVerificationResult (0 = verified … 6 = canceled), how: 'window' | 'plain' }.
   */
  async verify(hwnd, message) {
    const res = await this.send('verify', { hwnd: String(hwnd ?? 0), message: String(message).slice(0, 200) }, 200_000)
    return { result: res.result, how: res.how }
  }

  stop() {
    clearTimeout(this.idleTimer)
    const proc = this.proc
    if (!proc) return
    // forgotten now, so the next request starts a new helper instead of writing to this one
    this.proc = null
    this.ready = null
    try {
      proc.stdin.write('{"op":"exit"}\n')
      proc.stdin.end()
    } catch {}
    setTimeout(() => {
      try {
        proc.kill()
      } catch {}
    }, 1500).unref?.()
  }

  dispose() {
    this.stop()
  }
}

// ── IPC (optional helper for main.cjs) ─────────────────────────────────────

/**
 * Registers the Private IPC handlers (see the integration notes):
 *   private:status ()            → { unlocked, hello, hasPin, waitMs, count }   (also checks Windows Hello once)
 *   private:recheck-hello ()     → the same, after checking Windows Hello again (e.g. after a glitch)
 *   private:unlock-hello ()      → { ok, reason? }
 *   private:unlock-pin (pin)     → { ok, error?, waitMs? }
 *   private:set-pin (pin)        → { ok, error? }
 *   private:remove-pin ()        → boolean
 *   private:lock ()              → void
 *   private:items ()             → MediaItem[] (only while unlocked, else [])
 * and sends 'private:status' whenever the lock state changes.
 * deps: { ipcMain, priv, getWindow(), privateItems(), send(channel, payload) }
 * Marking items / moving them into the hidden folder touches the library, history and caches,
 * so those handlers live in main.cjs (see the notes).
 */
function registerIpc({ ipcMain, priv, getWindow, privateItems, send }) {
  priv.on('status', (s) => send('private:status', s))
  ipcMain.handle('private:status', async () => {
    if (priv.helloState === undefined) await priv.checkHello()
    return priv.status()
  })
  ipcMain.handle('private:recheck-hello', async () => {
    await priv.checkHello()
    return priv.status()
  })
  ipcMain.handle('private:unlock-hello', async () => {
    const win = getWindow()
    let hwnd = 0n
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
      const h = win.getNativeWindowHandle()
      hwnd = h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0))
    }
    return priv.unlockWithHello(hwnd, 'Unlock Private in Pics')
  })
  ipcMain.handle('private:unlock-pin', (_e, pin) => (typeof pin === 'string' ? priv.unlockWithPin(pin.slice(0, 64)) : { ok: false, error: 'Enter your PIN.' }))
  ipcMain.handle('private:set-pin', (_e, pin) => (typeof pin === 'string' ? priv.setPin(pin) : { ok: false, error: 'Enter a PIN.' }))
  ipcMain.handle('private:remove-pin', () => priv.removePin())
  ipcMain.handle('private:lock', () => priv.lock())
  ipcMain.handle('private:items', () => (priv.unlocked ? privateItems() : []))
}

module.exports = { PrivateFolder, HelloBridge, VAULT, LEGACY_VAULT, AVAILABILITY, RESULT, registerIpc, hideFolder }
