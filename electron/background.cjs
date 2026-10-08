const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { EventEmitter } = require('node:events')

// Background running (ported from DupeLens' MainWindow / InstallService / App):
//  - a notification-area (tray) icon while Pics watches folders, with Open / Stop watching / Exit
//  - notifications (clicking one opens the window)
//  - "Start with Windows" (login item started with --tray)
//  - "Scan with Pics" in Explorer's folder right-click menu (HKCU, no admin rights; via reg.exe)
//  - command-line arguments: --folder <path> or a folder as the first argument, --tray, --autoscan
//
// Electron is only loaded when a function needs it, so the pure parts (parseArgs, the registry
// commands) run in plain Node too; everything that touches the system takes an injectable
// `app` / `electron` / `run` for testing.

const ICON = path.join(__dirname, '..', 'resources', 'icon.png')

const TEXTS = {
  trayTooltip: 'Pics: watching for duplicates',
  trayOpen: 'Open Pics',
  trayStop: 'Stop watching',
  trayExit: 'Exit',
  /** Shown when closing the window hides Pics in the notification area. */
  stillWatchingTitle: 'Pics is still watching',
  stillWatchingBody: 'It will tell you when new duplicates appear. Right-click the icon to exit.',
  newDuplicateTitle: 'New duplicate found',
  contextMenu: 'Scan with Pics',
}

/** Where Explorer's folder right-click entries live (per user: no admin rights needed). */
const CONTEXT_MENU_KEYS = [
  'HKCU\\Software\\Classes\\Directory\\shell\\Pics',
  'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Pics',
]
/** The same entries from before Pics was renamed (Lumen, up to 1.15): replaced by the ones above. */
const LEGACY_CONTEXT_MENU_KEYS = CONTEXT_MENU_KEYS.map((key) => key.replace(/\\Pics$/, '\\Lumen'))

const electron = () => require('electron')

// ---------- command line ----------

const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * A path as Windows passed it. Explorer's "%V" for a drive root is "D:\", which Windows' argument
 * rules turn into D:" (the backslash escapes the closing quote): put the backslash back.
 */
const cleanPath = (p) => {
  let s = String(p).trim()
  if (s.startsWith('"')) s = s.slice(1)
  if (s.endsWith('"')) s = s.slice(0, -1) + '\\'
  return s
}

/**
 * Pics' own arguments from `argv` (process.argv, or the argv of a second launch):
 *  --folder <path> (or --folder=<path>), else the first plain argument when it is a folder
 *  (e.g. from "Scan with Pics" / "Open with"); --tray: start hidden in the notification area
 *  (used when starting with Windows); --autoscan: look for duplicates right away.
 * Chromium/Electron switches (--foo, --foo=bar) are ignored. When run as `electron <app>` (not
 * packaged), the first plain argument is the app itself and is skipped. A second launch's argv
 * (app 'second-instance') has its switches moved in front of the plain arguments by Chromium, so
 * `--folder` falls back to the first plain argument when no value follows it directly.
 * @returns {{ folder?: string, tray: boolean, autoscan: boolean }}
 */
function parseArgs(argv = process.argv, { cwd = process.cwd(), defaultApp = !!process.defaultApp, exists = isDirectory } = {}) {
  const args = (Array.isArray(argv) ? argv : []).slice(1).map(String)
  const out = { tray: false, autoscan: false }
  const isSwitch = (a) => a.startsWith('-')
  const plain = args.map((a, i) => (isSwitch(a) ? -1 : i)).filter((i) => i >= 0)
  const appArg = defaultApp ? plain.shift() : undefined
  let folder = null
  let wantFolder = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--tray') out.tray = true
    else if (a === '--autoscan') out.autoscan = true
    else if (a.startsWith('--folder=')) folder = a.slice('--folder='.length)
    else if (a === '--folder') {
      if (i + 1 < args.length && !isSwitch(args[i + 1]) && i + 1 !== appArg) {
        folder = args[i + 1]
        plain.splice(plain.indexOf(i + 1), 1)
      } else wantFolder = true
    }
  }
  if (folder) folder = path.resolve(cwd, cleanPath(folder))
  else if (plain.length) {
    // --folder without a value next to it: the first plain argument; else only a folder that exists
    const first = path.resolve(cwd, cleanPath(args[plain[0]]))
    if (wantFolder || exists(first)) folder = first
  }
  if (folder) out.folder = folder
  return out
}

// ---------- what Windows should run ----------

/**
 * The program (and arguments before Pics' own) that starts this Pics: the installed exe when
 * packaged; in development `electron.exe <app folder>`.
 * @returns {{ exe: string, args: string[], packaged: boolean }}
 */
function launchInfo({ app, execPath = process.execPath } = {}) {
  app ??= electron().app
  const packaged = !!app.isPackaged
  return { exe: execPath, args: packaged ? [] : [app.getAppPath()], packaged }
}

const quote = (s) => `"${s}"`

// ---------- start with Windows ----------

function loginItemOptions(app, execPath) {
  const launch = launchInfo({ app, execPath })
  // Electron joins `args` with spaces as they are, so paths must be quoted here.
  return { path: launch.exe, args: [...launch.args.map(quote), '--tray'] }
}

/** Start Pics quietly in the notification area when the user signs in (HKCU Run key). */
function startWithWindows(on, { app, execPath } = {}) {
  app ??= electron().app
  const o = loginItemOptions(app, execPath)
  app.setLoginItemSettings({ openAtLogin: !!on, path: o.path, args: o.args })
}

/**
 * Whether Pics will really start when the user signs in. openAtLogin stays true when Pics was
 * turned off in Task Manager → Startup apps (or Settings → Apps → Startup), so an entry only counts
 * while Windows has it enabled.
 */
function isStartWithWindows({ app, execPath } = {}) {
  app ??= electron().app
  const o = loginItemOptions(app, execPath)
  const s = app.getLoginItemSettings({ path: o.path, args: o.args })
  // (openAtLogin only looks at the entry named after the AppUserModelId; launchItems lists them all)
  const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase()
  const ours = (Array.isArray(s?.launchItems) ? s.launchItems : []).filter(
    (item) => item.scope === 'user' && same(item.path, o.path) && item.args?.includes('--tray'),
  )
  if (ours.length) return ours.some((item) => item.enabled !== false)
  return !!s?.openAtLogin && s.executableWillLaunchAtLogin !== false
}

/**
 * After an update that changed the program's file (Lumen.exe became Pics.exe in 1.16, or it was
 * installed somewhere else), the "Start with Windows" entry still names the old one, which isn't
 * there any more. Points it at this one, on or off in Task Manager as it was. Call once at startup
 * (installed copies only). Returns true when it was changed.
 */
function refreshStartWithWindows({ app, execPath, exists = fs.existsSync } = {}) {
  app ??= electron().app
  const o = loginItemOptions(app, execPath)
  const s = app.getLoginItemSettings({ path: o.path, args: o.args })
  const items = (Array.isArray(s?.launchItems) ? s.launchItems : []).filter((item) => item.scope === 'user')
  const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase()
  if (items.some((item) => same(item.path, o.path))) return false
  const old = items.find((item) => item.args?.includes('--tray') && /[\\/](lumen|pics)\.exe$/i.test(String(item.path)) && !exists(String(item.path)))
  if (!old) return false
  app.setLoginItemSettings({ openAtLogin: true, path: o.path, args: o.args, enabled: old.enabled !== false })
  // (an entry under another name than this one's would stay behind)
  const now = app.getLoginItemSettings({ path: o.path, args: o.args })
  if ((now?.launchItems ?? []).some((item) => item.scope === 'user' && item.name === old.name && !same(item.path, o.path))) {
    app.setLoginItemSettings({ openAtLogin: false, path: old.path, args: old.args, name: old.name })
  }
  return true
}

// ---------- "Scan with Pics" in Explorer ----------

/**
 * Runs reg.exe with `args` (no shell, so %V stays literal). Resolves { code, stdout, stderr }.
 * @param {string[]} args
 */
function runReg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** The command Explorer runs: "<exe>" ["<app folder>"] "%V". */
function contextMenuCommand(launch = launchInfo()) {
  return [launch.exe, ...launch.args, '%V'].map(quote).join(' ')
}

/** The reg.exe calls (argument lists) that add or remove the "Scan with Pics" entries. */
function contextMenuCommands(enabled, launch) {
  if (!enabled) return [...CONTEXT_MENU_KEYS, ...LEGACY_CONTEXT_MENU_KEYS].map((key) => ['delete', key, '/f'])
  launch ??= launchInfo()
  const command = contextMenuCommand(launch)
  return CONTEXT_MENU_KEYS.flatMap((key) => [
    ['add', key, '/v', 'MUIVerb', '/t', 'REG_SZ', '/d', TEXTS.contextMenu, '/f'],
    ['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', launch.exe, '/f'],
    ['add', `${key}\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'],
  ])
}

/**
 * Adds or removes "Scan with Pics" for folders and folder backgrounds. Throws when Windows
 * refused (message from reg.exe).
 * @param {{ run?: (args: string[]) => Promise<{ code: number, stdout?: string, stderr?: string }>, launch?: object, app?: object }} [options]
 */
async function setContextMenu(enabled, { run = runReg, launch, app } = {}) {
  if (enabled) launch ??= launchInfo({ app })
  for (const args of contextMenuCommands(enabled, launch)) {
    const res = await run(args)
    // removing an entry that isn't there is fine
    if (enabled && res.code !== 0) throw new Error((res.stderr || res.stdout || `reg.exe failed (${res.code})`).trim())
  }
  if (!enabled && (await isContextMenuEnabled({ run }))) throw new Error("Couldn't remove the right-click menu entry")
}

async function isContextMenuEnabled({ run = runReg } = {}) {
  return (await run(['query', CONTEXT_MENU_KEYS[0]])).code === 0 || (await hasLegacyContextMenu({ run }))
}

/** "Scan with Lumen" from before the rename is still there. */
async function hasLegacyContextMenu({ run = runReg } = {}) {
  return (await run(['query', LEGACY_CONTEXT_MENU_KEYS[0]])).code === 0
}

/** The command registered for "Scan with Pics" (null when there is none). */
async function readContextMenuCommand({ run = runReg } = {}) {
  const res = await run(['query', `${CONTEXT_MENU_KEYS[0]}\\command`, '/ve'])
  if (res.code !== 0) return null
  const line = String(res.stdout ?? '').split(/\r?\n/).find((l) => /\sREG_(EXPAND_)?SZ\s/.test(l))
  return line ? line.replace(/^.*?\sREG_(EXPAND_)?SZ\s+/, '').trim() : null
}

/**
 * When "Scan with Pics" is on but points at another Pics.exe (moved or reinstalled elsewhere),
 * registers it again for this one. Resolves true when it was updated. Call once at startup.
 */
async function refreshContextMenu({ run = runReg, launch, app } = {}) {
  if (!(await isContextMenuEnabled({ run }))) return false
  launch ??= launchInfo({ app })
  // "Scan with Lumen" (before the rename) becomes "Scan with Pics"
  if (await hasLegacyContextMenu({ run })) {
    await setContextMenu(true, { run, launch })
    for (const key of LEGACY_CONTEXT_MENU_KEYS) await run(['delete', key, '/f'])
    return true
  }
  if ((await readContextMenuCommand({ run })) === contextMenuCommand(launch)) return false
  await setContextMenu(true, { run, launch })
  return true
}

// ---------- tray icon & notifications ----------

/**
 * The notification-area icon and notifications. Emits 'open' (Open Pics, double-click, a
 * notification clicked), 'stop-watching' and 'exit'.
 */
class Background extends EventEmitter {
  constructor({ electron: e, icon = ICON } = {}) {
    super()
    this.electron = e ?? electron()
    this.icon = icon
    this.tray = null
    this.menu = null
    this.notes = new Set() // shown notifications (kept referenced so their click events fire)
    this.balloonClick = null
  }

  get trayVisible() {
    return !!this.tray && !this.tray.isDestroyed?.()
  }

  /** The app icon at the sizes Windows uses in the notification area (100–300 % scaling). */
  trayImage() {
    const { nativeImage } = this.electron
    const src = nativeImage.createFromPath(this.icon)
    if (src.isEmpty()) return src
    const img = nativeImage.createEmpty()
    for (const [scaleFactor, px] of [[1, 16], [1.25, 20], [1.5, 24], [2, 32], [3, 48]]) {
      img.addRepresentation({ scaleFactor, buffer: src.resize({ width: px, height: px, quality: 'best' }).toPNG() })
    }
    return img
  }

  /** Shows the tray icon (call while watching). Safe to call again. */
  showTray() {
    if (this.trayVisible) return this.tray
    const { Tray, Menu } = this.electron
    const tray = new Tray(this.trayImage())
    tray.setToolTip(TEXTS.trayTooltip)
    this.menu = Menu.buildFromTemplate([
      { label: TEXTS.trayOpen, click: () => this.emit('open') },
      { label: TEXTS.trayStop, click: () => this.emit('stop-watching') },
      { type: 'separator' },
      { label: TEXTS.trayExit, click: () => this.emit('exit') },
    ])
    tray.setContextMenu(this.menu)
    tray.on('double-click', () => this.emit('open'))
    tray.on('balloon-click', () => {
      const cb = this.balloonClick
      this.balloonClick = null
      this.emit('open')
      cb?.()
    })
    this.tray = tray
    return tray
  }

  /** Removes the tray icon (call when watching stops). */
  hideTray() {
    if (this.tray && !this.tray.isDestroyed?.()) this.tray.destroy()
    this.tray = null
    this.menu = null
  }

  /**
   * A Windows notification; clicking it emits 'open' (show the window) and calls `onClick`.
   * Falls back to a tray balloon when notifications aren't available.
   */
  notify(title, body, onClick) {
    const { Notification } = this.electron
    if (!Notification?.isSupported?.()) return this.balloon(title, body, onClick)
    const n = new Notification({ title, body, icon: this.icon })
    this.notes.add(n)
    const done = () => this.notes.delete(n)
    n.on('click', () => {
      done()
      this.emit('open')
      onClick?.()
    })
    n.on('close', done)
    n.on('failed', () => {
      done()
      this.balloon(title, body, onClick)
    })
    n.show()
    return n
  }

  balloon(title, body, onClick) {
    if (!this.trayVisible) return null
    this.balloonClick = onClick ?? null
    this.tray.displayBalloon({ title, content: body, iconType: 'info' })
    return this.tray
  }

  dispose() {
    for (const n of this.notes) n.close?.()
    this.notes.clear()
    this.hideTray()
    this.removeAllListeners()
  }
}

module.exports = {
  Background,
  TEXTS,
  ICON,
  CONTEXT_MENU_KEYS,
  LEGACY_CONTEXT_MENU_KEYS,
  refreshStartWithWindows,
  parseArgs,
  launchInfo,
  startWithWindows,
  isStartWithWindows,
  contextMenuCommand,
  contextMenuCommands,
  setContextMenu,
  isContextMenuEnabled,
  readContextMenuCommand,
  refreshContextMenu,
  runReg,
}
