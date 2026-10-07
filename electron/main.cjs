const os = require('node:os')

// Thumbnailing runs on libuv's thread pool (default: 4 threads). Size it to the machine
// before anything touches the pool — it's created on first use and can't grow later.
const cores = os.availableParallelism?.() ?? os.cpus().length
process.env.UV_THREADPOOL_SIZE ??= String(Math.max(4, Math.min(20, cores)))

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, nativeImage, Menu, clipboard } = require('electron')

if (process.env.LUMEN_USER_DATA) app.setPath('userData', path.resolve(process.env.LUMEN_USER_DATA))

const { Store } = require('./store.cjs')
const { Library, idOf, keyOf } = require('./library.cjs')
const { Thumbnails } = require('./thumbs.cjs')
const { FaceIndex } = require('./faces.cjs')
const { registerScheme, handleProtocol } = require('./protocol.cjs')

registerScheme()

// ---------- single instance (with hand-over to newer versions) ----------

const VERSION = app.getVersion()
const INSTANCE_FILE = path.join(app.getPath('userData'), 'instance.json')

const isNewer = (a, b) => {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

/**
 * Only one Lumen runs at a time. Launching a *newer* version while an older one (1.2+) is open
 * makes the old one quit and hand over, so the newest build is always the one you see.
 */
async function acquireSingleInstance() {
  const data = { version: VERSION }
  if (app.requestSingleInstanceLock(data)) return true
  let running = null
  try {
    running = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8')).version
  } catch {}
  if (!running || !isNewer(VERSION, running)) return false // the open window was focused instead
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (app.requestSingleInstanceLock(data)) return true
  }
  return false
}

const singleInstance = acquireSingleInstance()
let ownsInstance = false
singleInstance.then((ok) => {
  ownsInstance = ok
  if (!ok) app.exit(0)
})

const DEV_URL = process.env.VITE_DEV_SERVER_URL
const IS_MAC = process.platform === 'darwin'
const WIN_BUILD = process.platform === 'win32' ? Number(os.release().split('.')[2]) || 0 : 0
const MICA = WIN_BUILD >= 22621 && process.env.LUMEN_NO_MICA !== '1'
const TITLEBAR_HEIGHT = 44
const ICON = path.join(__dirname, '..', 'resources', 'icon.png')

const userData = app.getPath('userData')
const store = new Store(path.join(userData, 'settings.json'), {
  folders: [app.getPath('pictures'), app.getPath('videos')].filter((p) => fs.existsSync(p)),
  favorites: [],
  theme: 'system',
  accent: '#5b8cff',
  thumbSize: 180,
  highPerformanceGpu: true,
  faceRecognition: true,
  window: { width: 1360, height: 860 },
})

// On laptops with two GPUs (e.g. Intel + NVIDIA), Windows runs Chromium on the integrated one.
// This switch makes the GPU process use the discrete GPU: faster video decode and compositing.
// It must be set before the app is ready, so changing the setting needs a restart.
const HIGH_PERF_GPU = store.get('highPerformanceGpu') !== false
if (HIGH_PERF_GPU) app.commandLine.appendSwitch('force_high_performance_gpu')

// Created once this process owns the single-instance lock, so a second copy never touches
// the shared library index or thumbnail cache.
/** @type {Library} */
let library
/** @type {Thumbnails} */
let thumbs
/** @type {FaceIndex} */
let faces

function startServices() {
  library = new Library(path.join(userData, 'library.json'))
  thumbs = new Thumbnails(path.join(userData, 'thumbnails'))
  // Face analysis waits until every preview exists, so it never slows down browsing.
  faces = new FaceIndex(path.join(userData, 'faces.json'), {
    canRun: () => thumbs.background.pending === 0,
    render: (item) => thumbs.render(item),
    modelsDir: app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, '..', 'models'),
    adapterFile: path.join(userData, 'face-engine.json'),
  })
  faces.enabled = store.get('faceRecognition') !== false
  library.on('changed', () => {
    send('library:changed', { items: library.list })
    thumbs.warmUp(library.list)
  })
  library.on('status', (status) => send('scan:status', status))
  library.on('scanned', async () => {
    await thumbs.prune(library.list)
    thumbs.prefetch(library.list)
    faces.sync(library.list)
  })
  thumbs.on('progress', (progress) => {
    send('thumbs:progress', progress)
    if (progress.pending === 0) faces.pump()
  })
  thumbs.on('duration', (id, seconds) => library.patch(id, { duration: seconds }))
  faces.on('changed', () => send('people:changed', faces.snapshot()))
  faces.on('progress', (progress) => send('people:progress', progress))
}

/** @type {BrowserWindow | null} */
let win = null

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const settingsPayload = () => ({
  folders: store.get('folders'),
  favorites: store.get('favorites').map(idOf),
  theme: store.get('theme'),
  accent: store.get('accent'),
  thumbSize: store.get('thumbSize'),
  highPerformanceGpu: store.get('highPerformanceGpu') !== false,
  faceRecognition: store.get('faceRecognition') !== false,
})

let viewerOpen = false

const overlay = () => {
  const dark = nativeTheme.shouldUseDarkColors
  // The photo viewer is always dark, so the window buttons go light while it's open.
  if (viewerOpen) return { color: '#00000000', symbolColor: '#ffffff', height: TITLEBAR_HEIGHT }
  return {
    color: MICA ? '#00000000' : dark ? '#1b1c20' : '#eceef2',
    symbolColor: dark ? '#e6e7ea' : '#1c1d21',
    height: TITLEBAR_HEIGHT,
  }
}

function applyTheme() {
  nativeTheme.themeSource = store.get('theme')
  if (win && !IS_MAC) win.setTitleBarOverlay(overlay())
}

function scan() {
  library.scan(store.get('folders'))
}

function watchFolders() {
  library.watch(store.get('folders'), scan)
}

function createWindow() {
  const saved = store.get('window') || {}
  nativeTheme.themeSource = store.get('theme')

  win = new BrowserWindow({
    width: saved.width || 1360,
    height: saved.height || 860,
    x: saved.x,
    y: saved.y,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Lumen',
    icon: ICON,
    backgroundColor: MICA ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1b1c20' : '#eceef2',
    ...(MICA ? { backgroundMaterial: 'mica' } : {}),
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    ...(IS_MAC ? { trafficLightPosition: { x: 16, y: 15 } } : { titleBarOverlay: overlay() }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--lumen-mica=${MICA ? 1 : 0}`],
    },
  })

  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize()
    win.show()
    thumbs.warmUp(library.list)
  })

  win.on('close', () => {
    store.set({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } })
    store.saveNow()
  })
  win.on('closed', () => {
    win = null
    // Hidden media workers are windows too, so 'window-all-closed' wouldn't fire on its own.
    if (!IS_MAC) app.quit()
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setVisualZoomLevelLimits(1, 1)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
    if (DEV_URL && input.control && input.key.toLowerCase() === 'r') {
      win.webContents.reload()
      event.preventDefault()
    }
  })

  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

// ---------- IPC ----------

const itemsFor = (ids) => (Array.isArray(ids) ? ids : [ids]).map((id) => library.get(id)).filter(Boolean)

function setFavorites(ids, value) {
  const current = new Map(store.get('favorites').map((p) => [keyOf(p), p]))
  for (const item of itemsFor(ids)) {
    if (value) current.set(keyOf(item.path), item.path)
    else current.delete(keyOf(item.path))
  }
  store.set({ favorites: [...current.values()] })
  send('settings:changed', settingsPayload())
}

async function addFolders(paths) {
  let picked = paths
  if (!picked || !picked.length) {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a folder to your library',
      properties: ['openDirectory', 'multiSelections'],
    })
    if (res.canceled) return settingsPayload()
    picked = res.filePaths
  }
  const folders = [...store.get('folders')]
  const known = new Set(folders.map(keyOf))
  for (const p of picked) {
    try {
      if (!fs.statSync(p).isDirectory() || known.has(keyOf(p))) continue
    } catch {
      continue
    }
    folders.push(p)
    known.add(keyOf(p))
  }
  store.set({ folders })
  send('settings:changed', settingsPayload())
  watchFolders()
  scan()
  return settingsPayload()
}

ipcMain.handle('app:state', () => ({
  items: library.list,
  status: library.status(),
  settings: settingsPayload(),
  people: faces.snapshot(),
  peopleProgress: faces.progressInfo(),
  version: app.getVersion(),
}))

let gpuInfo = null
ipcMain.handle('app:gpu', async () => {
  if (!gpuInfo) {
    gpuInfo = (async () => {
      const info = await app.getGPUInfo('complete').catch(() => null)
      const active = info?.gpuDevice?.find((d) => d.active)
      const vendor = { 0x10de: 'NVIDIA', 0x8086: 'Intel', 0x1002: 'AMD' }[active?.vendorId] ?? 'Unknown'
      const status = app.getGPUFeatureStatus()
      return {
        name: active?.deviceString || vendor,
        vendor,
        gpuCount: info?.gpuDevice?.filter((d) => d.vendorId !== 0x1414).length ?? 1, // 0x1414 = Microsoft Basic Render
        hardwareVideoDecode: status.video_decode?.startsWith('enabled') ?? false,
        compositing: status.gpu_compositing?.startsWith('enabled') ?? false,
        highPerformanceRequested: HIGH_PERF_GPU,
      }
    })()
  }
  return gpuInfo
})

ipcMain.handle('app:relaunch', () => {
  app.relaunch()
  app.exit(0)
})

// ---------- people ----------

const isPersonId = (v) => typeof v === 'string' && /^p[0-9a-f]{10}$/.test(v)
const idList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

ipcMain.handle('people:rename', (_e, id, name) => {
  if (isPersonId(id) && typeof name === 'string') faces.rename(id, name)
})
ipcMain.handle('people:hide', (_e, id, hidden) => {
  if (isPersonId(id)) faces.setHidden(id, !!hidden)
})
ipcMain.handle('people:merge', (_e, fromIds, intoId) => {
  if (isPersonId(intoId)) faces.merge(idList(fromIds).filter(isPersonId), intoId)
})
ipcMain.handle('people:reject', (_e, id, itemIds) => {
  if (isPersonId(id)) faces.reject(id, idList(itemIds))
})
ipcMain.handle('people:reset', () => faces.reset())

const isFaceId = (v) => typeof v === 'string' && /^[0-9a-f]{16}:\d+$/.test(v)
ipcMain.handle('people:assign', (_e, faceIds, target) => {
  const ids = idList(faceIds).filter(isFaceId)
  if (isPersonId(target)) return faces.assignFaces(ids, target)
  if (target && typeof target === 'object' && typeof target.name === 'string') return faces.assignFaces(ids, { name: target.name })
  return null
})
ipcMain.handle('people:reject-faces', (_e, faceIds) => faces.rejectFaces(idList(faceIds).filter(isFaceId)))
ipcMain.handle('people:cover', (_e, id, faceId) => {
  if (isPersonId(id) && isFaceId(faceId)) faces.setCover(id, faceId)
})
ipcMain.handle('people:remove', (_e, id) => {
  if (isPersonId(id)) faces.removePerson(id)
})
ipcMain.handle('people:not-same', (_e, a, b) => {
  if (isPersonId(a) && isPersonId(b)) faces.markNotSame(a, b)
})
ipcMain.handle('people:hide-many', (_e, ids, hidden) => faces.setHiddenMany(idList(ids).filter(isPersonId), !!hidden))
ipcMain.handle('people:matches', (_e, id) => (isPersonId(id) ? faces.matches(id) : []))
ipcMain.handle('people:suggestions', () => faces.suggestions())

ipcMain.handle('library:rescan', () => scan())

ipcMain.handle('folders:add', (_e, paths) => addFolders(paths))

ipcMain.handle('folders:remove', (_e, folder) => {
  store.set({ folders: store.get('folders').filter((f) => keyOf(f) !== keyOf(folder)) })
  send('settings:changed', settingsPayload())
  watchFolders()
  scan()
  return settingsPayload()
})

ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = {}
  if (['system', 'light', 'dark'].includes(patch.theme)) allowed.theme = patch.theme
  if (typeof patch.accent === 'string' && /^#[0-9a-f]{6}$/i.test(patch.accent)) allowed.accent = patch.accent
  if (Number.isFinite(patch.thumbSize)) allowed.thumbSize = Math.max(72, Math.min(360, patch.thumbSize))
  if (typeof patch.highPerformanceGpu === 'boolean') allowed.highPerformanceGpu = patch.highPerformanceGpu
  if (typeof patch.faceRecognition === 'boolean') {
    allowed.faceRecognition = patch.faceRecognition
    faces.setEnabled(patch.faceRecognition)
  }
  store.set(allowed)
  if (allowed.theme) applyTheme()
  send('settings:changed', settingsPayload())
})

ipcMain.handle('favorites:set', (_e, ids, value) => setFavorites(ids, !!value))

ipcMain.handle('items:trash', async (_e, ids) => {
  const removed = []
  let failed = 0
  for (const item of itemsFor(ids)) {
    try {
      await shell.trashItem(item.path)
      removed.push(item.id)
    } catch {
      failed++
    }
  }
  if (removed.length) {
    setFavorites(removed, false)
    library.remove(removed)
    faces.removeItems(removed)
  }
  return { removed: removed.length, failed }
})

ipcMain.handle('items:reveal', (_e, id) => {
  const [item] = itemsFor(id)
  if (item) shell.showItemInFolder(item.path)
})

ipcMain.handle('items:open', (_e, id) => {
  const [item] = itemsFor(id)
  if (item) return shell.openPath(item.path)
})

ipcMain.handle('folders:reveal', (_e, dir) => {
  if (typeof dir === 'string' && fs.existsSync(dir)) shell.openPath(dir)
})

ipcMain.handle('items:copy', (_e, id, kind) => {
  const [item] = itemsFor(id)
  if (!item) return false
  if (kind === 'path') {
    clipboard.writeText(item.path)
    return true
  }
  const image = nativeImage.createFromPath(item.path)
  if (image.isEmpty()) return false
  clipboard.writeImage(image)
  return true
})

ipcMain.handle('items:menu', (event, id, ids) => {
  const targets = ids && ids.length ? ids : [id]
  const [item] = itemsFor(id)
  if (!item) return
  const multi = targets.length > 1
  const favs = new Set(store.get('favorites').map(keyOf))
  const allFav = itemsFor(targets).every((it) => favs.has(keyOf(it.path)))
  const action = (name) => () => send('menu:action', { action: name, id, ids: targets })
  const template = [
    ...(multi
      ? []
      : [
          { label: 'Open', click: action('open') },
          { label: 'Open with default app', click: () => shell.openPath(item.path) },
          { label: IS_MAC ? 'Reveal in Finder' : 'Show in Explorer', click: () => shell.showItemInFolder(item.path) },
          { type: 'separator' },
        ]),
    {
      label: allFav ? 'Remove from favorites' : multi ? `Add ${targets.length} to favorites` : 'Add to favorites',
      click: () => setFavorites(targets, !allFav),
    },
    ...(multi
      ? []
      : [
          ...(item.type === 'image'
            ? [{ label: 'Copy image', click: () => clipboard.writeImage(nativeImage.createFromPath(item.path)) }]
            : []),
          { label: 'Copy path', click: () => clipboard.writeText(item.path) },
        ]),
    { type: 'separator' },
    { label: multi ? `Move ${targets.length} items to Recycle Bin` : 'Move to Recycle Bin', click: action('delete') },
  ]
  Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(event.sender) })
})

ipcMain.on('items:drag', (event, ids) => {
  const items = itemsFor(ids)
  if (!items.length) return
  const cached = thumbs.cachedPath(items[0])
  let icon = cached ? nativeImage.createFromPath(cached) : nativeImage.createFromPath(ICON)
  if (!icon.isEmpty()) icon = icon.resize({ width: 96 })
  event.sender.startDrag({ file: items[0].path, files: items.map((it) => it.path), icon })
})

ipcMain.handle('items:duration', (_e, id, seconds) => {
  const [item] = itemsFor(id)
  if (item && item.type === 'video' && !item.duration && Number.isFinite(seconds) && seconds > 0) {
    library.patch(id, { duration: seconds })
  }
})

ipcMain.handle('window:viewer', (_e, open) => {
  viewerOpen = !!open
  if (win && !IS_MAC) win.setTitleBarOverlay(overlay())
})

ipcMain.handle('cache:info', () => thumbs.size())
ipcMain.handle('cache:clear', async () => {
  await thumbs.clear()
  thumbs.prefetch(library.list)
})

ipcMain.handle('shell:url', (_e, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url)
})

// ---------- lifecycle ----------

nativeTheme.on('updated', () => {
  if (win && !IS_MAC) win.setTitleBarOverlay(overlay())
})

app.on('second-instance', (_event, _argv, _cwd, data) => {
  if (data?.version && isNewer(data.version, VERSION)) {
    // A newer Lumen was just launched: close so it can take over.
    app.quit()
    return
  }
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(async () => {
  if (!(await singleInstance)) return
  try {
    fs.writeFileSync(INSTANCE_FILE, JSON.stringify({ version: VERSION, pid: process.pid }))
  } catch {}
  if (process.platform === 'win32') app.setAppUserModelId('app.lumen.gallery')
  Menu.setApplicationMenu(null)
  startServices()
  handleProtocol({ library, thumbs })
  await Promise.all([library.load(), faces.load()])
  createWindow()
  thumbs.prefetch(library.list)
  faces.sync(library.list)
  watchFolders()
  scan()

  app.on('activate', () => {
    if (!win) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (ownsInstance) store.saveNow()
  if (!IS_MAC) app.quit()
})

app.on('before-quit', () => {
  if (!ownsInstance) return
  store.saveNow()
  thumbs?.dispose()
  faces?.dispose()
})
