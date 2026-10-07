const os = require('node:os')

// Thumbnailing runs on libuv's thread pool (default: 4 threads). Size it to the machine
// before anything touches the pool — it's created on first use and can't grow later.
const cores = os.availableParallelism?.() ?? os.cpus().length
process.env.UV_THREADPOOL_SIZE ??= String(Math.max(4, Math.min(20, cores)))

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, nativeImage, Menu, clipboard } = require('electron')

if (process.env.LUMEN_USER_DATA) app.setPath('userData', path.resolve(process.env.LUMEN_USER_DATA))

// LUMEN_TRACE=<file>: append startup/shutdown milestones with timestamps (for diagnosing).
const trace = process.env.LUMEN_TRACE
  ? (msg) => {
      try {
        fs.appendFileSync(process.env.LUMEN_TRACE, `${new Date().toISOString().slice(11, 23)} [${process.pid}] ${msg}\n`)
      } catch {}
    }
  : () => {}
trace(`start v${app.getVersion()}`)

const { Store } = require('./store.cjs')
const { Library, idOf, keyOf } = require('./library.cjs')
const { Thumbnails } = require('./thumbs.cjs')
const { FaceIndex } = require('./faces.cjs')
const { Albums } = require('./albums.cjs')
const { Duplicates } = require('./duplicates.cjs')
const { Places } = require('./places.cjs')
const { SmartIndex } = require('./smart.cjs')
const { Editor } = require('./editor.cjs')
const { History } = require('./history.cjs')
const cleanup = require('./cleanup.cjs')
const edits = require('./edits.cjs')
const { isJpeg } = require('./jpeg-exif.cjs')
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Is `pid` a running copy of this app (same executable name)? Guards against reused PIDs. */
function isOurProcess(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid === process.pid) return false
  try {
    const out = require('node:child_process').execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    return out.toLowerCase().startsWith(`"${path.basename(process.execPath).toLowerCase()}"`)
  } catch {
    return false
  }
}

/**
 * Only one Lumen runs at a time. Launching a *newer* version while an older one (1.2+) is open
 * makes the old one quit and hand over, so the newest build is always the one you see. An old
 * copy that can't quit (1.6.0 could get stuck in the background after its window closed) is
 * ended after 5 seconds.
 */
async function acquireSingleInstance() {
  const data = { version: VERSION }
  if (app.requestSingleInstanceLock(data)) return true
  let running = null
  try {
    running = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'))
  } catch {}
  if (!running?.version || !isNewer(VERSION, running.version)) return false // the open window was focused instead
  const waitForLock = async () => {
    for (let i = 0; i < 25; i++) {
      await sleep(200)
      if (app.requestSingleInstanceLock(data)) return true
    }
    return false
  }
  if (await waitForLock()) return true
  if (!isOurProcess(running.pid)) return false
  try {
    process.kill(running.pid)
  } catch {
    return false
  }
  return waitForLock()
}

const singleInstance = acquireSingleInstance()
let ownsInstance = false
singleInstance.then((ok) => {
  trace(ok ? 'single-instance lock acquired' : 'another copy is running: exiting')
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
  smartSearch: true,
  // Clean up (from DupeLens)
  dupeSensitivity: 90,
  findCrops: true,
  keepRule: 'best',
  protectedFolders: [],
  moveDestination: null,
  carryDates: true,
  blurThreshold: 30,
  largeFileMB: 10,
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
/** @type {Albums} */
let albums
/** @type {Duplicates} */
let dupes
/** @type {Places} */
let places
/** @type {SmartIndex} */
let smart
let placesData = { places: [], byItem: {} }
/** @type {Editor} */
let editor
/** @type {History} */
let history

const MODELS_DIR = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, '..', 'models')

function startServices() {
  library = new Library(path.join(userData, 'library.json'))
  thumbs = new Thumbnails(path.join(userData, 'thumbnails'))
  // Background analysis (faces, search, duplicates) waits until every preview exists, so it never
  // slows down browsing.
  const idle = () => thumbs.background.pending === 0
  faces = new FaceIndex(path.join(userData, 'faces.json'), {
    canRun: idle,
    render: (item) => thumbs.render(item),
    modelsDir: MODELS_DIR,
    adapterFile: path.join(userData, 'face-engine.json'),
  })
  faces.enabled = store.get('faceRecognition') !== false
  smart = new SmartIndex(path.join(userData, 'smart.bin'), {
    canRun: idle,
    thumb: (item) => thumbs.ensure(item),
    modelsDir: MODELS_DIR,
    adapterFile: path.join(userData, 'smart-engine.json'),
    hintFile: path.join(userData, 'face-engine.json'),
  })
  smart.enabled = store.get('smartSearch') !== false
  dupes = new Duplicates(path.join(userData, 'duplicates.json'), { canRun: idle, thumb: (item) => thumbs.ensure(item) })
  configureDupes()
  history = new History(path.join(userData, 'history.json'))
  history.on('changed', () => send('history:changed', history.list()))
  albums = new Albums(path.join(userData, 'albums.json'))
  places = new Places(path.join(MODELS_DIR, 'places.json.gz'))
  editor = new Editor({ thumbs })

  let placesTimer = null
  const updatePlaces = () => {
    clearTimeout(placesTimer)
    placesTimer = setTimeout(() => {
      placesData = places.group(library.list)
      send('places:changed', placesData)
    }, 400)
  }
  library.on('changed', () => {
    send('library:changed', { items: library.list })
    thumbs.warmUp(library.list)
    updatePlaces()
  })
  library.on('status', (status) => send('scan:status', status))
  library.on('scanned', async () => {
    await thumbs.prune(library.list)
    thumbs.prefetch(library.list)
    faces.sync(library.list)
    smart.sync(library.list)
    dupes.sync(library.list)
  })
  thumbs.on('progress', (progress) => {
    send('thumbs:progress', progress)
    if (progress.pending === 0) {
      faces.pump()
      smart.pump()
      dupes.pump()
    }
  })
  thumbs.on('duration', (id, seconds) => library.patch(id, { duration: seconds }))
  faces.on('changed', () => send('people:changed', faces.snapshot()))
  faces.on('progress', (progress) => send('people:progress', progress))
  smart.on('progress', (progress) => send('smart:progress', progress))
  dupes.on('changed', () => send('dupes:changed', dupes.snapshot()))
  dupes.on('progress', (progress) => send('dupes:progress', progress))
  albums.on('changed', () => send('albums:changed', albums.snapshot()))
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
  smartSearch: store.get('smartSearch') !== false,
  dupeSensitivity: store.get('dupeSensitivity'),
  findCrops: store.get('findCrops') !== false,
  keepRule: store.get('keepRule'),
  protectedFolders: store.get('protectedFolders'),
  moveDestination: store.get('moveDestination'),
  defaultMoveDestination: defaultMoveDestination(),
  carryDates: store.get('carryDates') !== false,
  blurThreshold: store.get('blurThreshold'),
  largeFileMB: store.get('largeFileMB'),
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

/** Where 'Move to folder' puts removed duplicates: <first library folder>\Duplicates unless chosen. */
function defaultMoveDestination() {
  const first = store.get('folders')[0]
  return first ? path.join(first, 'Duplicates') : path.join(app.getPath('pictures'), 'Duplicates')
}
const moveDestination = () => store.get('moveDestination') || defaultMoveDestination()

/** Folders never scanned: removed duplicates, HEIC originals kept aside after converting. */
function excludedFolders() {
  const first = store.get('folders')[0]
  return [moveDestination(), ...(first ? [path.join(first, 'HEIC originals')] : [])]
}

function configureDupes() {
  dupes.configure({
    sensitivity: store.get('dupeSensitivity'),
    findCrops: store.get('findCrops') !== false,
    folders: store.get('folders'),
  })
}

function scan() {
  library.scan(store.get('folders'), excludedFolders())
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

  trace('window created')
  win.once('ready-to-show', () => {
    trace('window shown')
    if (saved.maximized) win.maximize()
    win.show()
    servicesReady.then(() => thumbs.warmUp(library.list))
  })

  win.on('close', () => {
    trace('window close')
    store.set({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } })
    store.saveNow()
  })
  win.on('closed', () => {
    trace('window closed')
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
  configureDupes()
  send('settings:changed', settingsPayload())
  watchFolders()
  scan()
  return settingsPayload()
}

// The window opens while saved data is still loading; the UI's first request waits for it.
let markServicesReady
const servicesReady = new Promise((resolve) => (markServicesReady = resolve))

ipcMain.handle('app:state', async () => {
  await servicesReady
  return appState()
})

const appState = () => ({
  items: library.list,
  status: library.status(),
  settings: settingsPayload(),
  people: faces.snapshot(),
  peopleProgress: faces.progressInfo(),
  albums: albums.snapshot(),
  places: placesData,
  dupes: dupes.snapshot(),
  history: history.list(),
  dupesProgress: dupes.progressInfo(),
  smartProgress: smart.progressInfo(),
  version: app.getVersion(),
})

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

// ---------- albums ----------

const isAlbumId = (v) => typeof v === 'string' && /^a[0-9a-f]{10}$/.test(v)

ipcMain.handle('albums:create', (_e, name, ids) => albums.create(typeof name === 'string' ? name : '', itemsFor(idList(ids))))
ipcMain.handle('albums:rename', (_e, id, name) => {
  if (isAlbumId(id) && typeof name === 'string') albums.rename(id, name)
})
ipcMain.handle('albums:delete', (_e, id) => {
  if (isAlbumId(id)) albums.remove(id)
})
ipcMain.handle('albums:add', (_e, id, ids) => (isAlbumId(id) ? albums.add(id, itemsFor(idList(ids))) : 0))
ipcMain.handle('albums:remove-items', (_e, id, ids) => {
  if (isAlbumId(id)) albums.removeItems(id, idList(ids))
})
ipcMain.handle('albums:cover', (_e, id, itemId) => {
  const [item] = itemsFor(itemId)
  if (isAlbumId(id) && item) albums.setCover(id, item)
})

// ---------- editing ----------

ipcMain.handle('edit:preview', async (_e, id, recipe, size) => {
  const [item] = itemsFor(id)
  if (!item || item.type !== 'image') return { error: 'Only photos can be edited' }
  try {
    const res = await editor.preview(item, recipe, Math.max(400, Math.min(2400, Number(size) || 1600)))
    return { data: new Uint8Array(res.data), width: res.width, height: res.height }
  } catch (err) {
    return { error: String(err?.message || err) }
  }
})
ipcMain.handle('edit:save', async (_e, id, recipe) => {
  const [item] = itemsFor(id)
  if (!item || item.type !== 'image') return { error: 'Only photos can be edited' }
  try {
    const file = await editor.save(item, recipe)
    scan() // pick the new copy up right away (the folder watcher would too, a moment later)
    return { id: idOf(file), name: path.basename(file) }
  } catch (err) {
    return { error: String(err?.message || err) }
  }
})
ipcMain.handle('edit:close', () => editor.release())

// ---------- lossless edits (JPEG metadata only; from DupeLens) ----------

const backupsDir = () => path.join(userData, 'backups')

/**
 * A lossless edit keeps the file's date (so an old photo doesn't look new), which means the caches
 * keyed on size + date wouldn't notice: drop this photo's preview, fingerprint, faces and search
 * vector, and read it again.
 */
async function refreshEdited(paths) {
  for (const p of paths) {
    const it = library.items.get(keyOf(p))
    if (!it) continue
    for (const kind of ['thumb', 'preview']) {
      const name = thumbs.name(it, kind)
      thumbs.cached.delete(name)
      await fs.promises.rm(path.join(thumbs.dir, name), { force: true }).catch(() => {})
    }
    dupes.records.delete(it.id)
    smart.vectors.delete(it.id)
    faces.removeItems([it.id])
    library.items.delete(keyOf(p)) // re-read on the next scan
  }
  scan()
}

/** Turns JPEGs by quarter turns (orientation tag only). Resolves { done, errors }. */
ipcMain.handle('edit:rotate', async (_e, ids, turns) => {
  const items = itemsFor(idList(ids)).filter((it) => isJpeg(it.ext))
  const q = Math.round(Number(turns)) || 0
  const files = []
  const errors = []
  for (const it of items) {
    const res = await edits.rotate(it, q, backupsDir())
    if (res.error) errors.push(`${it.name}: ${res.error}`)
    else files.push(res.file)
  }
  if (files.length) {
    const how = ((q % 4) + 4) % 4 === 1 ? '90° right' : ((q % 4) + 4) % 4 === 3 ? '90° left' : '180°'
    history.add({
      kind: 'edited',
      note: files.length === 1 ? `Turned ${path.basename(files[0].from)} ${how}` : `Turned ${files.length} photos ${how}`,
      files,
    })
    await refreshEdited(files.map((f) => f.from))
  }
  return { done: files.length, errors }
})

/** Writes the date taken into a JPEG (EXIF, lossless) and sets its file date to match. */
ipcMain.handle('edit:date', async (_e, id, ms) => {
  const [it] = itemsFor(id)
  if (!it || !isJpeg(it.ext)) return { error: 'Only JPEG photos can be changed without re-saving them.' }
  const date = Number(ms)
  if (!Number.isFinite(date) || new Date(date).getFullYear() < 1900 || date > Date.now() + 86_400_000) return { error: 'That date looks wrong.' }
  const res = await edits.setDateTaken(it, date, backupsDir())
  if (res.error) return { error: res.error }
  history.add({ kind: 'edited', note: `Date taken of ${it.name} set to ${new Date(date).toLocaleString()}`, files: [res.file] })
  await refreshEdited([it.path])
  return { ok: true }
})

// ---------- duplicates & search ----------

ipcMain.handle('dupes:dismiss', (_e, ids) => dupes.dismiss(idList(ids)))
ipcMain.handle('smart:search', (_e, query) => (typeof query === 'string' ? smart.search(query.slice(0, 200)) : { ids: [], scores: [] }))

ipcMain.handle('library:rescan', () => scan())

ipcMain.handle('folders:add', (_e, paths) => addFolders(paths))

ipcMain.handle('folders:remove', (_e, folder) => {
  store.set({ folders: store.get('folders').filter((f) => keyOf(f) !== keyOf(folder)) })
  configureDupes()
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
  if (typeof patch.smartSearch === 'boolean') {
    allowed.smartSearch = patch.smartSearch
    smart.setEnabled(patch.smartSearch)
  }
  if (Number.isFinite(patch.dupeSensitivity)) allowed.dupeSensitivity = Math.round(Math.min(99, Math.max(80, patch.dupeSensitivity)))
  if (typeof patch.findCrops === 'boolean') allowed.findCrops = patch.findCrops
  if (['best', 'sharpest', 'largest', 'oldest', 'newest'].includes(patch.keepRule)) allowed.keepRule = patch.keepRule
  if (Array.isArray(patch.protectedFolders)) allowed.protectedFolders = patch.protectedFolders.filter((p) => typeof p === 'string' && fs.existsSync(p))
  if (patch.moveDestination === null || (typeof patch.moveDestination === 'string' && path.isAbsolute(patch.moveDestination))) allowed.moveDestination = patch.moveDestination
  if (typeof patch.carryDates === 'boolean') allowed.carryDates = patch.carryDates
  if (Number.isFinite(patch.blurThreshold)) allowed.blurThreshold = Math.min(80, Math.max(5, Math.round(patch.blurThreshold)))
  if (Number.isFinite(patch.largeFileMB)) allowed.largeFileMB = Math.min(500, Math.max(5, Math.round(patch.largeFileMB)))
  store.set(allowed)
  if ('dupeSensitivity' in allowed || 'findCrops' in allowed) configureDupes()
  if ('moveDestination' in allowed) scan()
  if (allowed.theme) applyTheme()
  send('settings:changed', settingsPayload())
})

ipcMain.handle('favorites:set', (_e, ids, value) => setFavorites(ids, !!value))

/** Files that left the library (moved away or recycled): drop them everywhere. */
function forgetItems(ids) {
  if (!ids.length) return
  setFavorites(ids, false)
  library.remove(ids)
  faces.removeItems(ids)
  albums.forget(ids)
  smart.sync(library.list)
  dupes.sync(library.list)
}

/**
 * Recycle Bin or move to a folder. Before removing, kept copies in the same duplicate groups can
 * get the original's date (carry dates). Every action is recorded in History.
 */
async function removeItems(ids, how, dest) {
  const items = itemsFor(idList(ids))
  if (!items.length) return { removed: 0, failed: 0, errors: [] }
  const removing = new Set(items.map((it) => it.id))
  const byId = new Map(library.list.map((it) => [it.id, it]))
  const dateChanges = store.get('carryDates') !== false ? await cleanup.carryDates(dupes.groupsOf([...removing]), removing, byId) : []
  const destination = how === 'move' ? dest || moveDestination() : undefined
  const res = how === 'move' ? await cleanup.moveTo(items, destination) : await cleanup.recycle(items)
  let entry = null
  if (res.files.length || dateChanges.length) {
    entry = history.add({
      kind: how === 'move' ? 'moved' : 'recycled',
      destination,
      files: res.files.map(({ id, ...f }) => f),
      dateChanges,
    })
  }
  forgetItems(res.files.map((f) => f.id))
  return { removed: res.files.length, failed: res.errors.length, errors: res.errors, entryId: entry?.id ?? null, destination }
}

ipcMain.handle('items:trash', (_e, ids) => removeItems(ids, 'recycle'))
ipcMain.handle('cleanup:move', (_e, ids, dest) => removeItems(ids, 'move', typeof dest === 'string' && path.isAbsolute(dest) ? dest : undefined))
ipcMain.handle('cleanup:pick-destination', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Where should removed duplicates go?',
    defaultPath: moveDestination(),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  store.set({ moveDestination: res.filePaths[0] })
  send('settings:changed', settingsPayload())
  scan()
  return res.filePaths[0]
})
ipcMain.handle('cleanup:pick-folder', async (_e, title) => {
  const res = await dialog.showOpenDialog(win, { title: typeof title === 'string' ? title : 'Choose a folder', properties: ['openDirectory', 'multiSelections'] })
  return res.canceled ? [] : res.filePaths
})

// ---------- history ----------

ipcMain.handle('history:list', () => history.list())
ipcMain.handle('history:clear', async () => {
  await edits.deleteBackups(history.list(), backupsDir()).catch(() => {})
  return history.clear()
})
ipcMain.handle('history:restore', async (_e, id) => {
  const entry = typeof id === 'string' ? history.get(id) : null
  if (!entry) return { restored: 0 }
  let restored = 0
  if (entry.kind === 'edited') {
    const done = await edits.restoreBackups(entry.files)
    restored = done.length
    if (restored) await refreshEdited(done.map((f) => f.from))
  } else if (entry.kind === 'moved' || entry.kind === 'renamed') {
    restored = await cleanup.restoreMoves(entry.files)
    await cleanup.restoreDates(entry.dateChanges)
  } else if (entry.kind === 'dates') {
    for (const f of entry.files) {
      if (f.restored || !Number.isFinite(f.oldMtime)) continue
      try {
        await cleanup.setFileDate(f.from, f.oldMtime)
        f.restored = true
        restored++
      } catch {}
    }
  }
  history.changed(entry)
  if (restored) scan()
  return { restored, total: entry.files.length }
})
ipcMain.handle('shell:recycle-bin', () => {
  if (process.platform === 'win32') require('node:child_process').spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' }).unref()
})

// ---------- reports ----------

ipcMain.handle('report:save', async (_e, html, csv) => {
  if (typeof html !== 'string' || typeof csv !== 'string') return null
  const stamp = new Date().toISOString().slice(0, 10)
  const res = await dialog.showSaveDialog(win, {
    title: 'Export a report',
    defaultPath: path.join(app.getPath('documents'), `Lumen report ${stamp}.html`),
    filters: [
      { name: 'Web page report', extensions: ['html'] },
      { name: 'Spreadsheet', extensions: ['csv'] },
    ],
  })
  if (res.canceled || !res.filePath) return null
  const asCsv = res.filePath.toLowerCase().endsWith('.csv')
  await fs.promises.writeFile(res.filePath, asCsv ? '﻿' + csv : html, 'utf8')
  return res.filePath
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
    { label: multi ? `Add ${targets.length} to album…` : 'Add to album…', click: action('album') },
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
  trace(`second launch (v${data?.version}) · window ${win ? 'open' : 'none'}`)
  if (data?.version && isNewer(data.version, VERSION)) {
    // A newer Lumen was just launched: close so it can take over.
    app.quit()
    return
  }
  // No window (e.g. still starting, or closed while background work finished): open one.
  if (!win) {
    if (!quitting && library) createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
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
  // Show the window right away; the saved library, faces, albums… load meanwhile (~0.5 s).
  createWindow()
  await Promise.all([library.load(), faces.load(), albums.load(), dupes.load(), smart.load(), history.load()])
  placesData = places.group(library.list)
  markServicesReady()
  trace(`data loaded: ${library.list.length} items`)
  thumbs.prefetch(library.list)
  faces.sync(library.list)
  smart.sync(library.list)
  dupes.sync(library.list)
  watchFolders()
  scan()

  app.on('activate', () => {
    if (!win) createWindow()
  })
})

app.on('window-all-closed', () => {
  trace('all windows closed')
  if (ownsInstance) store.saveNow()
  if (!IS_MAC) app.quit()
})

let quitting = false

app.on('before-quit', () => {
  if (!ownsInstance || quitting) return
  quitting = true
  trace('quitting: saving and stopping background work')
  store.saveNow()
  thumbs?.dispose()
  faces?.dispose()
  smart?.dispose()
  dupes?.dispose()
  albums?.saveNow()
  // Everything is saved. If anything still holds the app open, don't linger invisibly in the
  // background (that blocks the next launch): exit for real.
  trace('saved')
  setTimeout(() => {
    trace('still running 3 s after quit: forcing exit')
    app.exit(0)
  }, 3000).unref()
})

app.on('will-quit', () => trace('will-quit'))
app.on('quit', () => trace('quit'))
