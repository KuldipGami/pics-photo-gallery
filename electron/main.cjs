const os = require('node:os')

// Thumbnailing runs on libuv's thread pool (default: 4 threads). Size it to the machine
// before anything touches the pool — it's created on first use and can't grow later.
const cores = os.availableParallelism?.() ?? os.cpus().length
process.env.UV_THREADPOOL_SIZE ??= String(Math.max(4, Math.min(20, cores)))

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, nativeImage, Menu, clipboard, session, powerMonitor, screen } = require('electron')

if (process.env.LUMEN_USER_DATA) app.setPath('userData', path.resolve(process.env.LUMEN_USER_DATA))
else {
  // Pics was called Lumen before 1.16. Its data folder (people's names, ratings, albums, History,
  // previews…) stays where it is and is used as it is: moving it isn't worth any risk to it.
  const has = (dir) => fs.existsSync(path.join(dir, 'settings.json'))
  const lumen = path.join(app.getPath('appData'), 'Lumen')
  if (!has(app.getPath('userData')) && has(lumen)) app.setPath('userData', lumen)
}

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
const { Library, idOf, keyOf, extOf, FILE_TYPES, skippedExtensions } = require('./library.cjs')
const { Thumbnails } = require('./thumbs.cjs')
const { FaceIndex } = require('./faces.cjs')
const { Albums } = require('./albums.cjs')
const { Duplicates } = require('./duplicates.cjs')
const { VideoFrames } = require('./video-frames.cjs')
const { Places } = require('./places.cjs')
const { SmartIndex } = require('./smart.cjs')
const { Editor } = require('./editor.cjs')
const { Eraser } = require('./eraser.cjs')
const videoEdit = require('./video-edit.cjs')
const { makeMovie } = require('./movie.cjs')
const { History } = require('./history.cjs')
const cleanup = require('./cleanup.cjs')
const edits = require('./edits.cjs')
const { isJpeg, setSwapJournal, recoverSwaps } = require('./jpeg-exif.cjs')
const ffmpeg = require('./ffmpeg.cjs')
const organize = require('./organize.cjs')
const { Locations, assignLocations, historyNote } = require('./locations.cjs')
const locSuggest = require('./location-suggest.cjs')
const { Tags } = require('./tags.cjs')
const { Importer } = require('./importer.cjs')
const { OcrIndex } = require('./ocr.cjs')
const exporter = require('./exporter.cjs')
const { PrivateFolder, registerIpc: registerPrivateIpc } = require('./private.cjs')
const bgx = require('./background.cjs')
const { WatchAlerts } = require('./watch-alerts.cjs')
const { registerScheme, handleProtocol } = require('./protocol.cjs')

registerScheme()

// "Scan with Pics" (folder right-click), --folder <dir>, --autoscan, --tray (started with Windows)
const launchArgs = bgx.parseArgs(process.argv)

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

/** What the running copy wrote to instance.json: { version, pid, finishingUntil? } (null if unreadable). */
function readInstanceFile() {
  try {
    return JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'))
  } catch {
    return null
  }
}

/** Longest the newer copy waits for an older one finishing a file job before ending it. */
const HANDOVER_LIMIT_MS = 100_000

/**
 * Only one Pics runs at a time. Launching a *newer* version while an older one (1.2+) is open
 * makes the old one quit and hand over, so the newest build is always the one you see. An old
 * copy that can't quit (1.6.0 could get stuck in the background after its window closed) is
 * ended after 5 seconds, unless it said it is finishing a file job (instance.json
 * `finishingUntil`): then it gets until that time, so it can record what it moved.
 */
async function acquireSingleInstance() {
  const data = { version: VERSION }
  if (app.requestSingleInstanceLock(data)) return true
  const running = readInstanceFile()
  if (!running?.version || !isNewer(VERSION, running.version)) return false // the open window was focused instead
  const waitForLock = async (ms = 5000) => {
    for (const until = Date.now() + ms; Date.now() < until; ) {
      await sleep(200)
      if (app.requestSingleInstanceLock(data)) return true
    }
    return false
  }
  if (await waitForLock()) return true
  const finishing = Number(readInstanceFile()?.finishingUntil) - Date.now()
  if (finishing > 0 && (await waitForLock(Math.min(finishing, HANDOVER_LIMIT_MS) + 2000))) return true
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
  textSearch: true,
  // Clean up (from DupeLens)
  dupeSensitivity: 90,
  findCrops: true,
  keepRule: 'best',
  protectedFolders: [],
  moveDestination: null,
  carryDates: true,
  tagsInFiles: true,
  xmpSidecars: false,
  exportOptions: null,
  // Import
  importDestination: null,
  importFolderPattern: organize.DEFAULTS.folderPattern,
  importSkipKnown: true,
  importConvertHeic: false,
  importHeicOriginals: 'aside',
  blurThreshold: 30,
  largeFileMB: 10,
  // Organize (from DupeLens)
  organizeRoot: null,
  folderPattern: organize.DEFAULTS.folderPattern,
  organizeCopy: false,
  renamePattern: organize.DEFAULTS.renamePattern,
  deviceNamesOnly: true,
  jpegQuality: 92,
  moveOriginals: true,
  // Background (from DupeLens)
  watchFolders: false,
  minimizeToTray: false,
  skippedFolders: [],
  skippedTypes: [],
  minFileKB: 0,
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
/** @type {VideoFrames} */
let videoFrames
/** @type {Places} */
let places
/** @type {SmartIndex} */
let smart
let placesData = { places: [], byItem: {} }
/** @type {Editor} */
let editor
/** Magic eraser (LaMa inpainting, on the GPU) used by the editor. */
let eraser
/** @type {History} */
let history
/** User-set places for files that can't store one (HEIC, PNG, videos). */
let userLocations
/** Ratings & tags set in Pics (written into JPEGs in the background). */
let tags
/** Import from phones, cameras, cards and folders. */
let importer
/** Text in photos (Windows' own OCR). */
let ocr
/** Private: items hidden from every view until unlocked (Windows Hello or a Pics PIN). */
let priv
/** @type {WatchAlerts} */
let alerts
/** @type {import('./background.cjs').Background} */
let background
/** "Scan with Pics" is in the folder right-click menu (read from Windows at startup). */
let contextMenuOn = false
// Folder events that came in while Pics was moving files itself (replayed afterwards).
const heldFileEvents = []
/** The analyses (faces, search, text, duplicates) haven't followed the library's latest change yet. */
let indexesStale = false
/** The saved library, faces, albums… have been loaded. */
let dataLoaded = false
/**
 * The library holds every library folder's items: it was loaded from library.json, or a scan has
 * read every folder since. Until then, a folder that couldn't be read has no items at all.
 */
let libraryComplete = false

const MODELS_DIR = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, '..', 'models')

function startServices() {
  library = new Library(path.join(userData, 'library.json'))
  priv = new PrivateFolder(path.join(userData, 'private.json'), {
    roots: () => store.get('folders'),
    dataDir: userData,
    // (until the library holds every folder's items, every file marked private counts too:
    // "nothing private" must be sure)
    count: () => {
      const hidden = dataLoaded ? priv.split(library.list).hidden.length : 0
      return libraryComplete ? hidden : Math.max(hidden, priv.hashes.size)
    },
  })
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
  ocr = new OcrIndex(path.join(userData, 'ocr.json'), {
    canRun: idle,
    // a HEIC's viewer preview, when there is one, reads ~2× quicker than the HEIC itself
    image: (item) => {
      const name = thumbs.name(item, 'preview')
      return thumbs.cached.has(name) ? path.join(thumbs.dir, name) : null
    },
    render: (item) => thumbs.source(item), // only when Windows can't decode the file
  })
  ocr.enabled = store.get('textSearch') !== false
  // Look-alike videos: frames read from the videos themselves, one at a time in the background.
  // While the window is in use, frames are read by playing (smooth) rather than seeking.
  videoFrames = new VideoFrames(path.join(userData, 'video-frames.bin'), {
    canRun: idle,
    analyze: (item, options) => thumbs.videoFrames(item, options),
    gentle: () => !!win && !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized(),
  })
  dupes = new Duplicates(path.join(userData, 'duplicates.json'), { canRun: idle, thumb: (item) => thumbs.ensure(item), videoFrames })
  videoFrames.on('progress', (progress) => send('dupes:videos', progress))
  configureDupes()
  history = new History(path.join(userData, 'history.json'))
  history.on('changed', () => send('history:changed', history.list()))
  albums = new Albums(path.join(userData, 'albums.json'))
  userLocations = new Locations(path.join(userData, 'locations.json'))
  importer = new Importer({ file: path.join(userData, 'imports.json') })
  tags = new Tags(path.join(userData, 'tags.json'), { writeFiles: store.get('tagsInFiles') !== false, sidecars: !!store.get('xmpSidecars') })
  tags.on('changed', (snapshot) => send('tags:changed', snapshot))
  tags.on('writing', (file) => ownFiles([file]))
  tags.on('written', ({ id, size, rating, tags: list }) => {
    // the date is kept, so previews, faces and search vectors stay valid: only the size changed
    library.patch(id, { size, ...(rating !== undefined && { rating }), ...(list && { tags: list }) })
    const r = dupes.records.get(id)
    if (r) {
      r.z = size
      delete r.x // no longer byte-identical to its copies
      dupes.saveSoon()
    }
  })
  tags.on('write-error', ({ name, message }) => send('tags:error', `Couldn't save the rating or tags inside ${name}: ${message} Pics keeps them anyway.`))
  places = new Places(path.join(MODELS_DIR, 'places.json.gz'))
  eraser = new Eraser({
    modelsDir: MODELS_DIR,
    adapterFile: path.join(userData, 'eraser-engine.json'),
    hintFile: [path.join(userData, 'face-engine.json'), path.join(userData, 'smart-engine.json')],
  })
  editor = new Editor({ thumbs, eraser })

  let placesTimer = null
  const updatePlaces = () => {
    clearTimeout(placesTimer)
    placesTimer = setTimeout(() => {
      placesData = places.group(listed())
      send('places:changed', placesData)
    }, 400)
  }
  registerPrivateIpc({ ipcMain, priv, getWindow: () => win, send, privateItems: () => userLocations.apply(priv.split(library.list).hidden) })
  priv.on('changed', () => {
    send('library:changed', { items: listedJson() })
    send('private:changed')
    updatePlaces()
    // (not before the library knows every folder's items: see 'scanned' below)
    if (!libraryComplete) {
      indexesStale = true
      return
    }
    const shown = visibleLibrary()
    faces.sync(shown)
    smart.sync(shown)
    ocr.sync(shown)
    dupes.sync(shown)
  })
  powerMonitor.on('lock-screen', () => priv.lock())
  powerMonitor.on('suspend', () => priv.lock())
  userLocations.on('changed', () => {
    send('library:changed', { items: listedJson() })
    updatePlaces()
  })
  // The analyses follow the library after a scan. One that found nothing new (with no other change
  // since the last one) leaves them alone: re-syncing them re-forms every duplicate group, which
  // holds up this process for about a second.
  library.on('changed', () => {
    indexesStale = true
    send('library:changed', { items: listedJson() })
    thumbs.warmUp(library.list)
    updatePlaces()
  })
  let unreachableBefore = []
  library.on('status', (status) => {
    send('scan:status', status)
    // A library folder that couldn't be read is back (a drive or share connected again): watching
    // for new duplicates leaves out folders missing when it started, so start it again.
    const now = Array.isArray(status?.unreachable) ? status.unreachable : []
    const back = unreachableBefore.some((r) => !now.some((n) => folderKey(n) === folderKey(r)))
    unreachableBefore = now
    if (back) updateWatching()
  })
  library.on('scanned', async () => {
    // A library folder this scan couldn't read (drive not connected, share not there yet) kept its
    // items as they were. With no saved library to go by (library.json missing, damaged or
    // unreadable at start), nothing is known about its photos yet: dropping what isn't in the
    // library now would delete their faces, names, tags and text for good. Wait for a scan that
    // reads every folder.
    if (!libraryComplete && library.unreachable.length) {
      indexesStale = true
      thumbs.prefetch(visibleLibrary())
      return
    }
    if (!library.unreachable.length) libraryComplete = true
    tags.reconcile(library.list)
    // (ratings and tags of files in a folder that couldn't be read stay: their files weren't checked)
    const unchecked = library.unreachable.length ? [...tags.entries.values()].filter((e) => library.isUnreachable(e.path)).map((e) => ({ path: e.path })) : []
    tags.prune(unchecked.length ? [...library.list, ...unchecked] : library.list)
    if (!indexesStale) {
      thumbs.prefetch(visibleLibrary()) // previews that failed earlier get another try
      return
    }
    indexesStale = false
    await thumbs.prune(library.list)
    thumbs.prefetch(visibleLibrary())
    faces.sync(visibleLibrary())
    smart.sync(visibleLibrary())
    ocr.sync(visibleLibrary())
    dupes.sync(visibleLibrary())
  })
  thumbs.on('progress', (progress) => {
    send('thumbs:progress', progress)
    if (progress.pending === 0) {
      faces.pump()
      smart.pump()
      ocr.pump()
      dupes.pump()
    }
  })
  thumbs.on('duration', (id, seconds) => library.patch(id, { duration: seconds }))
  faces.on('changed', () => send('people:changed', JSON.stringify(faces.snapshot())))
  faces.on('progress', (progress) => send('people:progress', progress))
  smart.on('progress', (progress) => send('smart:progress', progress))
  ocr.on('progress', (progress) => send('ocr:progress', progress))
  ocr.on('changed', () => send('ocr:changed'))
  dupes.on('changed', () => send('dupes:changed', JSON.stringify(dupes.snapshot())))
  dupes.on('progress', (progress) => send('dupes:progress', progress))
  albums.on('changed', () => send('albums:changed', albums.snapshot()))

  // HEIC / RAW: sharp can't read them, so new ones are compared through their preview.
  const NON_SHARP = new Set(['heic', 'heif', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'bmp', 'ico'])
  alerts = new WatchAlerts({
    items: () => visibleLibrary(),
    records: () => dupes.records,
    sensitivity: () => store.get('dupeSensitivity'),
    findCrops: () => store.get('findCrops') !== false,
    exclude: () => [...excludedFolders(), ...store.get('skippedFolders')],
    skipTypes: () => store.get('skippedTypes'),
    minBytes: () => store.get('minFileKB') * 1024,
    decode: async (file, ext) =>
      NON_SHARP.has(ext)
        ? thumbs.ensure({ id: idOf(file), path: file, name: path.basename(file), ext, type: 'image', mtime: Math.round((await fs.promises.stat(file)).mtimeMs) })
        : null,
  })
  library.on('file', (file, event) => {
    if (scanHolds) heldFileEvents.push([file, event])
    else alerts.queue(file, event)
  })
  background = new bgx.Background({ icon: ICON })
  alerts.on('status', (status) => {
    if (status.watching) background.showTray()
    else background.hideTray()
    send('watch:status', status)
    send('settings:changed', settingsPayload())
  })
  alerts.on('alert', (alert) => {
    send('watch:alert', { alert, log: alerts.log.map((a) => a.line) })
    send('settings:changed', settingsPayload())
    notify(bgx.TEXTS.newDuplicateTitle, alert.text, () => {
      showDuplicates()
      showWindow()
    })
  })
  background.on('open', showWindow)
  background.on('stop-watching', () => {
    store.set({ watchFolders: false })
    alerts.stop()
    send('settings:changed', settingsPayload())
    if (!win?.isVisible()) showWindow() // never leave an invisible app behind
  })
  background.on('exit', () => app.quit())
}

/** Starts or stops watching for new duplicates to match the setting and the library folders. */
function updateWatching() {
  if (!alerts) return
  if (store.get('watchFolders')) alerts.start(store.get('folders'))
  else alerts.stop()
}

/** A Windows notification (LUMEN_NO_NOTIFY=1 keeps automated tests off the desktop). */
const notify = (title, body, onClick) => {
  if (process.env.LUMEN_NO_NOTIFY !== '1') background?.notify(title, body, onClick)
}

/** Files Pics itself just wrote, moved or put back: they are not new duplicates. */
const ownFiles = (files) => alerts?.ignore(files.filter(Boolean))

function showWindow() {
  if (quitting) return
  if (!win) {
    if (library) createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Pics was asked to open a folder: add it to the library unless it's already in it, then show it. */
async function openFolder(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return
  } catch {
    return
  }
  if (!inLibraryFolders(dir)) await addFolders([dir])
  launchRequest = { ...launchRequest, folder: dir }
  send('app:open-folder', dir)
}

/** Show Clean up (after --autoscan or a duplicate notification). */
function showDuplicates() {
  launchRequest = { ...launchRequest, duplicates: true }
  send('app:show-duplicates')
}

// What a window that is still loading should show first (taken by its first app:state).
let launchRequest = null

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
  textSearch: store.get('textSearch') !== false,
  dupeSensitivity: store.get('dupeSensitivity'),
  findCrops: store.get('findCrops') !== false,
  keepRule: store.get('keepRule'),
  protectedFolders: store.get('protectedFolders'),
  moveDestination: store.get('moveDestination'),
  defaultMoveDestination: defaultMoveDestination(),
  carryDates: store.get('carryDates') !== false,
  tagsInFiles: store.get('tagsInFiles') !== false,
  xmpSidecars: !!store.get('xmpSidecars'),
  importDestination: store.get('importDestination'),
  importFolderPattern: store.get('importFolderPattern'),
  importSkipKnown: store.get('importSkipKnown') !== false,
  importConvertHeic: !!store.get('importConvertHeic'),
  importHeicOriginals: store.get('importHeicOriginals') || 'aside',
  blurThreshold: store.get('blurThreshold'),
  largeFileMB: store.get('largeFileMB'),
  organizeRoot: store.get('organizeRoot'),
  folderPattern: store.get('folderPattern'),
  organizeCopy: !!store.get('organizeCopy'),
  renamePattern: store.get('renamePattern'),
  deviceNamesOnly: store.get('deviceNamesOnly') !== false,
  jpegQuality: store.get('jpegQuality'),
  moveOriginals: store.get('moveOriginals') !== false,
  originalsDir: originalsDir(),
  watchFolders: !!store.get('watchFolders'),
  minimizeToTray: !!store.get('minimizeToTray'),
  startWithWindows: startsWithWindows(),
  contextMenu: contextMenuOn,
  skippedFolders: store.get('skippedFolders'),
  skippedTypes: store.get('skippedTypes'),
  minFileKB: store.get('minFileKB'),
  fileTypes: FILE_TYPES,
  watchStatus: alerts?.statusText ?? '',
  watchLog: alerts ? alerts.log.map((a) => a.line) : [],
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

/** A path compared case-insensitively, without trailing separators ("D:\" → "d:"). */
const folderKey = (p) => keyOf(String(p)).replace(/[\\/]+$/, '')
/** `p` is `folder` or inside it (works for drive roots too). */
const isWithin = (p, folder) => {
  const k = folderKey(p)
  const f = folderKey(folder)
  return !!f && (k === f || k.startsWith(f + path.sep))
}
/** `p` is one of the library folders or inside one. */
const inLibraryFolders = (p) => store.get('folders').some((f) => isWithin(p, f))
/** `dir` sits inside a library folder (not one itself) and holds none: safe to leave out of scans. */
const strictlyInsideLibrary = (dir) => {
  const folders = store.get('folders')
  return folders.some((f) => isWithin(dir, f) && folderKey(dir) !== folderKey(f)) && !folders.some((f) => isWithin(f, dir))
}

/** A native message box in front of Pics' window (or on its own when there's none). */
const messageBox = (options) =>
  (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).catch(() => null)

/** Where 'Move to folder' puts removed duplicates: <first library folder>\Duplicates unless chosen. */
function defaultMoveDestination() {
  const first = store.get('folders')[0]
  return first ? path.join(first, 'Duplicates') : path.join(app.getPath('pictures'), 'Duplicates')
}
const moveDestination = () => store.get('moveDestination') || defaultMoveDestination()

/**
 * Why `dest` can't take removed duplicates, or null when it can. The folder they go to is left out
 * of scans, so a library folder, a folder holding one or a whole drive would hide the library and
 * every name, tag and analysis with it.
 */
function moveDestinationProblem(dest) {
  if (typeof dest !== 'string' || !path.isAbsolute(dest)) return 'Choose a folder for removed duplicates.'
  const resolved = path.resolve(dest)
  if (folderKey(path.parse(resolved).root) === folderKey(resolved)) {
    return `“${resolved}” is a whole drive. Choose a folder inside your library (for example “${defaultMoveDestination()}”) or one outside it.`
  }
  const folders = store.get('folders')
  const same = folders.find((f) => folderKey(f) === folderKey(resolved))
  if (same) return `“${same}” is one of your library folders. Choose a folder inside it (for example “${path.join(same, 'Duplicates')}”) or one outside your library.`
  const held = folders.find((f) => isWithin(f, resolved))
  if (held) return `“${resolved}” holds your library folder “${held}”. Choose a folder inside your library (for example “${defaultMoveDestination()}”) or one outside it.`
  return null
}

/** Explains (in a message box) why a folder was refused for removed duplicates. */
const refuseMoveDestination = (problem) =>
  messageBox({ type: 'warning', title: 'Pics', message: "That folder can't hold removed duplicates", detail: `${problem}\n\nThe folder they go to isn't shown in Pics, so this one would hide your photos.`, buttons: ['OK'] })

/** Folders never scanned: removed duplicates, HEIC originals kept aside after converting. */
function excludedFolders() {
  const first = store.get('folders')[0]
  return [
    moveDestination(),
    ...(first ? [path.join(first, 'HEIC originals')] : []),
    // exports land in Pictures (a library folder by default): they'd all show up as duplicates
    path.join(app.getPath('pictures'), 'Pics exports'),
    // Only a folder inside a library folder is left out (one outside isn't scanned anyway). Leaving
    // out a library folder itself, one holding a library folder or a whole drive ("D:\") would hide
    // the library from scans, and the scan would then drop everything known about it.
  ].filter(strictlyInsideLibrary)
}

function configureDupes() {
  dupes.configure({
    sensitivity: store.get('dupeSensitivity'),
    findCrops: store.get('findCrops') !== false,
    folders: store.get('folders'),
  })
}

// While Pics itself moves or renames files, scans wait: a scan halfway through would drop the
// moved files' faces, fingerprints and previews before relocate() can carry them over.
let scanHolds = 0
let scanWanted = false
function scan() {
  if (scanHolds) {
    scanWanted = true
    return
  }
  library.scan(store.get('folders'), excludedFolders(), scanOptions())
}

function scanOptions() {
  return {
    skipFolders: store.get('skippedFolders'),
    skipTypes: store.get('skippedTypes'),
    minBytes: store.get('minFileKB') * 1024,
  }
}

function startsWithWindows() {
  try {
    return bgx.isStartWithWindows()
  } catch {
    return false
  }
}

/** Runs `task` with scans on hold (after any scan already running), then scans once. */
async function withScansHeld(task) {
  scanHolds++
  try {
    for (let i = 0; library.scanning && !quitting && i < 600; i++) await new Promise((r) => setTimeout(r, 100))
    return await tags.hold(task)
  } finally {
    if (--scanHolds === 0) {
      scanWanted = false
      // (not while quitting: everything moved was carried over by relocate() and saved)
      if (!quitting) {
        scan()
        // new files that arrived meanwhile still get checked (Pics' own are ignored by now)
        for (const [file, event] of heldFileEvents.splice(0)) alerts?.queue(file, event)
      }
    }
  }
}

// ---------- file jobs (finished and recorded before Pics quits) ----------

/**
 * Jobs that move, rename, convert, remove or put back files (Organize, Clean up, Import, History,
 * Private, lossless edits): each { controller, done }. Quitting stops them (controller.abort(): the
 * engines stop before the next file and return what they did) and waits until each one has
 * recorded that in History and carried everything over to the new paths.
 */
const fileJobs = new Set()

/** Runs `task(signal, controller)` as a file job (it starts right away). Resolves or rejects as the task does. */
function fileJob(task) {
  const controller = new AbortController()
  const job = { controller, done: null }
  fileJobs.add(job)
  job.done = (async () => {
    try {
      return await task(controller.signal, controller)
    } finally {
      fileJobs.delete(job)
    }
  })()
  return job.done
}
const CLOSING = 'Pics is closing.'

function watchFolders() {
  library.watch(store.get('folders'), scan)
}

/**
 * The saved window position still shows its title bar on a screen (a monitor unplugged or an undocked
 * laptop would put it off-screen, where it can't be reached).
 */
function onScreen(b) {
  if (!Number.isFinite(b?.x) || !Number.isFinite(b?.y)) return false
  const width = Number(b.width) || 1360
  try {
    return screen.getAllDisplays().some(({ workArea: a }) => {
      const across = Math.min(b.x + width, a.x + a.width) - Math.max(b.x, a.x)
      const down = Math.min(b.y + TITLEBAR_HEIGHT, a.y + a.height) - Math.max(b.y, a.y)
      return across >= 160 && down >= TITLEBAR_HEIGHT / 2
    })
  } catch {
    return false
  }
}

function createWindow() {
  const saved = store.get('window') || {}
  nativeTheme.themeSource = store.get('theme')
  const placed = onScreen(saved) // otherwise Windows centres it on the main screen

  win = new BrowserWindow({
    width: saved.width || 1360,
    height: saved.height || 860,
    ...(placed && { x: saved.x, y: saved.y }),
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Pics',
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

  win.on('close', (e) => {
    trace('window close')
    store.set({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } })
    store.saveNow()
    // "Keep watching in the notification area when closed"
    if (!quitting && store.get('watchFolders') && store.get('minimizeToTray') && alerts?.watching) {
      e.preventDefault()
      win.hide()
      notify(bgx.TEXTS.stillWatchingTitle, bgx.TEXTS.stillWatchingBody)
      return
    }
    // A file job is running: quitting stops it after the current file and records what it did;
    // the window stays until then (a few seconds at most) and closes with the quit.
    if (!quitting && fileJobs.size) {
      e.preventDefault()
      app.quit()
    }
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
    // Developer tools only in development: in the installed app they could unlock Private.
    if (!app.isPackaged && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
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

/** Library items by id. While Private is locked, private items aren't served (to open, show, copy, drag, export…). */
const itemsFor = (ids) => {
  const items = (Array.isArray(ids) ? ids : [ids]).map((id) => library.get(id)).filter(Boolean)
  return priv && !priv.unlocked ? items.filter((it) => !priv.isPrivate(it.path)) : items
}

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
  updateWatching()
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

/** The library as the UI sees it: with the places the user set for files that can't hold one. */
const listed = () => userLocations.apply(visibleLibrary())
/**
 * The same as JSON text, which is how it goes to the window (so do the people and duplicates
 * snapshots): ~15,000 items copied into the page (and across the preload bridge) as a structure
 * took several times longer than parsing text, up to ~0.3 s with the page frozen.
 */
const listedJson = () => JSON.stringify(listed())
/** The library without private items (all of it while nothing is private). */
function visibleLibrary() {
  return priv ? priv.split(library.list).shown : library.list
}

// (the big parts, items, people and duplicates, go as JSON text: see listedJson)
const appState = () => ({
  items: listedJson(),
  status: library.status(),
  settings: settingsPayload(),
  people: JSON.stringify(faces.snapshot()),
  peopleProgress: faces.progressInfo(),
  albums: albums.snapshot(),
  places: placesData,
  dupes: JSON.stringify(dupes.snapshot()),
  history: history.list(),
  tags: tags.snapshot(),
  dupesProgress: dupes.progressInfo(),
  videosProgress: videoFrames.progressInfo(),
  smartProgress: smart.progressInfo(),
  ocrProgress: ocr.progressInfo(),
  version: app.getVersion(),
  launch: takeLaunchRequest(),
})
function takeLaunchRequest() {
  const req = launchRequest
  launchRequest = null
  return req
}

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

// (quit, not exit: running file jobs finish and everything is saved first; the new copy starts after)
ipcMain.handle('app:relaunch', () => {
  app.relaunch()
  app.quit()
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
ipcMain.handle('albums:create-smart', (_e, name, query) =>
  typeof query === 'string' && query.trim() ? albums.createSmart(typeof name === 'string' ? name : '', query) : null,
)
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
    ownFiles([file])
    keepPrivate(item, file)
    scan() // pick the new copy up right away (the folder watcher would too, a moment later)
    return { id: idOf(file), name: path.basename(file) }
  } catch (err) {
    return { error: String(err?.message || err) }
  }
})
/** A copy made from a private photo or video (edit, frame) is private too, before the library sees it. */
function keepPrivate(item, file) {
  if (file && priv.isPrivate(item.path)) priv.add([file])
}
ipcMain.handle('edit:close', () => editor.release())
ipcMain.handle('edit:erase', async (_e, id, recipe, strokes) => {
  const [item] = itemsFor(id)
  if (!item || item.type !== 'image') return { error: 'Only photos can be edited' }
  try {
    return await editor.erase(item, recipe, strokes)
  } catch (err) {
    return { error: String(err?.message || err) }
  }
})
ipcMain.handle('edit:eraser', (_e, warm) => eraser.status(!!warm))

// ---------- video edits & memory movies (ffmpeg) ----------

let videoJob = null
let movieJob = null
/** Movies made in this session: the only files movie:open / movie:reveal will touch. */
const movieFiles = new Set()
/** Music chosen with movie:pick-music in this session: the only audio files handed to ffmpeg. */
const musicFiles = new Set()
const failure = (err) => (err?.canceled ? { canceled: true } : { error: String(err?.message || err) })

ipcMain.handle('video:info', async (_e, id) => {
  const [it] = itemsFor(id)
  if (it?.type !== 'video') return { error: 'Only videos can be edited' }
  try {
    return await videoEdit.videoInfo(it.path)
  } catch (err) {
    return failure(err)
  }
})
ipcMain.handle('video:save', async (_e, id, recipe) => {
  const [it] = itemsFor(id)
  if (it?.type !== 'video') return { error: 'Only videos can be edited' }
  videoJob?.abort()
  const job = (videoJob = new AbortController())
  try {
    const r = await videoEdit.saveEdit(it, recipe, { signal: job.signal, onProgress: (f) => send('video:progress', f) })
    ownFiles([r.file])
    keepPrivate(it, r.file)
    scan()
    return { id: idOf(r.file), name: path.basename(r.file), mode: r.mode }
  } catch (err) {
    return failure(err)
  } finally {
    if (videoJob === job) videoJob = null
    send('video:progress', null)
  }
})
ipcMain.handle('video:cancel', () => videoJob?.abort())
ipcMain.handle('video:frame', async (_e, id, seconds) => {
  const [it] = itemsFor(id)
  if (it?.type !== 'video') return { error: 'Only videos can be edited' }
  try {
    const r = await videoEdit.saveFrame(it, Number(seconds) || 0)
    ownFiles([r.file])
    keepPrivate(it, r.file)
    scan()
    return { id: idOf(r.file), name: path.basename(r.file) }
  } catch (err) {
    return failure(err)
  }
})

ipcMain.handle('movie:pick-music', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose music for the movie',
    properties: ['openFile'],
    filters: [
      { name: 'Music', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  const file = r.canceled ? null : (r.filePaths[0] ?? null)
  if (file) musicFiles.add(file)
  return file
})
ipcMain.handle('movie:make', async (_e, req) => {
  const items = itemsFor(idList(req?.ids))
  if (!items.length) return { error: 'Choose some photos or videos for the movie' }
  if (req.music && !musicFiles.has(req.music)) return { error: 'Choose the music again.' }
  const name = String(req.title || 'Movie').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Movie'
  const s = await dialog.showSaveDialog(win, {
    title: 'Save the movie',
    defaultPath: path.join(app.getPath('videos'), `${name}.mp4`),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  })
  if (s.canceled || !s.filePath) return null
  movieJob?.abort()
  const job = (movieJob = new AbortController())
  // keep faces in frame: the middle of the faces found (tuples [id, person, x, y, w, h, dist])
  const byItem = faces.snapshot().byItem
  const focusOf = (it) => {
    const f = byItem[it.id]?.faces
    if (!f?.length) return undefined
    return { x: f.reduce((a, t) => a + t[2] + t[4] / 2, 0) / f.length, y: f.reduce((a, t) => a + t[3] + t[5] / 2, 0) / f.length }
  }
  try {
    const r = await makeMovie(
      {
        ...req,
        items: items.map((it) => ({ ...it, focus: focusOf(it) })),
        getSource: (it) => thumbs.source(it),
        output: s.filePath,
        date: Math.max(...items.map((it) => it.date)),
      },
      { signal: job.signal, onProgress: (p) => send('movie:progress', p) },
    )
    movieFiles.add(r.file)
    ownFiles([r.file])
    scan()
    return r
  } catch (err) {
    return err?.canceled ? null : failure(err)
  } finally {
    if (movieJob === job) movieJob = null
    send('movie:progress', null)
  }
})
ipcMain.handle('movie:cancel', () => movieJob?.abort())
ipcMain.handle('movie:open', (_e, f) => movieFiles.has(f) && shell.openPath(f))
ipcMain.handle('movie:reveal', (_e, f) => {
  if (movieFiles.has(f)) shell.showItemInFolder(f)
})

// ---------- lossless edits (JPEG metadata only; from DupeLens) ----------

const backupsDir = () => path.join(userData, 'backups')

/**
 * A lossless edit keeps the file's date (so an old photo doesn't look new), which means the caches
 * keyed on size + date wouldn't notice: drop this photo's preview, fingerprint, faces and search
 * vector, and read it again.
 */
async function refreshEdited(paths) {
  ownFiles(paths)
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
    ocr.records.delete(it.id)
    faces.removeItems([it.id])
    library.items.delete(keyOf(p)) // re-read on the next scan
  }
  scan()
}

/**
 * Files Pics moved or renamed inside the library: an item's id is a hash of its path, so carry
 * everything known about it (library entry, preview, fingerprint, faces, search vector, favorite,
 * albums, History) over to the new path instead of analysing it again. `pairs`: [{ from, to, sidecar? }].
 * `history: false` for pairs that aren't moves (a HEIC handing over to the JPG made from it): History
 * entries keep pointing at the files themselves.
 */
async function relocate(pairs, { history: followInHistory = true } = {}) {
  const ids = new Map()
  const paths = new Map()
  const items = new Map(library.items)
  const favs = new Map(store.get('favorites').map((p) => [keyOf(p), p]))
  let favChanged = false
  for (const { from, to } of pairs) {
    if (!from || !to || keyOf(from) === keyOf(to)) continue
    const it = items.get(keyOf(from))
    const oldId = idOf(from)
    const newId = idOf(to)
    ids.set(oldId, newId)
    paths.set(keyOf(from), to)
    if (it) {
      items.delete(keyOf(from))
      items.set(keyOf(to), { ...it, id: newId, path: to, name: path.basename(to), dir: path.dirname(to), ext: extOf(to) })
      for (const kind of ['thumb', 'preview']) {
        const before = thumbs.name(it, kind)
        if (!thumbs.cached.has(before)) continue
        const after = before.replace(oldId, newId)
        try {
          await fs.promises.rename(path.join(thumbs.dir, before), path.join(thumbs.dir, after))
          thumbs.cached.delete(before)
          thumbs.cached.add(after)
        } catch {}
      }
    }
    // (duplicate fingerprints and dismissed groups: dupes.remapIds below)
    for (const map of [smart.vectors, videoFrames.records, ocr.records]) {
      if (map.has(oldId)) {
        map.set(newId, map.get(oldId))
        map.delete(oldId)
      }
    }
    if (favs.has(keyOf(from))) {
      favs.delete(keyOf(from))
      favs.set(keyOf(to), to)
      favChanged = true
    }
  }
  if (!ids.size) return
  send('items:relocated', [...ids])
  library.setItems(items)
  library.emit('changed')
  library.save()
  faces.remapIds(ids)
  dupes.remapIds(ids)
  albums.remapPaths(paths)
  priv.remap(pairs)
  tags.remapPaths(paths)
  userLocations.remap(pairs)
  // older History entries follow the files, so undoing them acts where the files are now
  if (followInHistory) history.remapPaths(pairs)
  dupes.saveSoon(2000)
  smart.saveSoon(2000)
  videoFrames.saveSoon(2000)
  ocr.saveSoon(2000)
  if (favChanged) {
    store.set({ favorites: [...favs.values()] })
    send('settings:changed', settingsPayload())
  }
}

/** A file's date changed but its picture didn't (date fixes): keep its preview and analysis. */
async function retime(changes) {
  const items = new Map(library.items)
  const faceChanges = []
  for (const { path: file, mtime } of changes) {
    const it = items.get(keyOf(file))
    if (!it || !Number.isFinite(mtime)) continue
    const next = { ...it, mtime: Math.round(mtime) }
    if (!it.taken) next.date = Math.min(next.mtime, it.added)
    items.set(keyOf(file), next)
    for (const kind of ['thumb', 'preview']) {
      const before = thumbs.name(it, kind)
      if (!thumbs.cached.has(before)) continue
      const after = thumbs.name(next, kind)
      try {
        await fs.promises.rename(path.join(thumbs.dir, before), path.join(thumbs.dir, after))
        thumbs.cached.delete(before)
        thumbs.cached.add(after)
      } catch {}
    }
    for (const r of [dupes.records.get(it.id), smart.vectors.get(it.id), videoFrames.records.get(it.id), ocr.records.get(it.id)]) if (r) r.m = next.mtime
    faceChanges.push({ id: it.id, mtime: next.mtime })
  }
  library.setItems(items)
  library.emit('changed')
  library.save()
  faces.retime(faceChanges)
  ocr.saveSoon(2000)
}

// ---------- organize (from DupeLens) ----------

const organizeOptions = () => ({
  root: store.get('organizeRoot') || store.get('folders')[0] || null,
  roots: store.get('folders'),
  folderPattern: store.get('folderPattern'),
  renamePattern: store.get('renamePattern'),
  deviceNamesOnly: store.get('deviceNamesOnly') !== false,
  copy: !!store.get('organizeCopy'),
  quality: store.get('jpegQuality'),
  moveOriginals: store.get('moveOriginals') !== false,
})
function originalsDir() {
  return path.join(store.get('folders')[0] ?? app.getPath('pictures'), organize.HEIC_ORIGINALS)
}

ipcMain.handle('organize:plan', (_e, skip) => {
  const o = organizeOptions()
  return organize.summarize(visibleLibrary(), { ...o, skip: new Set(idList(skip)) })
})
ipcMain.handle('organize:pick-root', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Where should the dated folders go?', properties: ['openDirectory', 'createDirectory'] })
  if (res.canceled || !res.filePaths[0]) return null
  store.set({ organizeRoot: res.filePaths[0] })
  send('settings:changed', settingsPayload())
  return res.filePaths[0]
})

/** Stats files after their dates changed (for retime). */
async function newTimes(files) {
  const out = []
  for (const file of files) {
    try {
      out.push({ path: file, mtime: (await fs.promises.stat(file)).mtimeMs })
    } catch {}
  }
  return out
}

/** A converted HEIC whose original went aside: its favorite, albums, faces… follow the JPG. */
const convertedPairs = (entry) => {
  const jpgOf = new Map(entry.files.map((f) => [keyOf(f.from), f.to]))
  return (entry.movedOriginals ?? []).map((m) => ({ from: m.from, to: jpgOf.get(keyOf(m.from)) })).filter((p) => p.to)
}

let organizing = false
ipcMain.handle('organize:run', async (_e, action, skip) => {
  if (organizing) return { done: 0, errors: ['Another change is still running.'] }
  if (quitting) return { done: 0, errors: [CLOSING] }
  organizing = true
  try {
    return await fileJob((signal) => withScansHeld(() => runOrganize(action, new Set(idList(skip)), signal)))
  } catch (err) {
    return { done: 0, errors: [String(err?.message ?? err)] }
  } finally {
    organizing = false
    send('organize:progress', null)
  }
})

async function runOrganize(action, skipped, signal) {
  const o = organizeOptions()
  const kept = visibleLibrary().filter((it) => !skipped.has(it.id))
  if (signal?.aborted) return { done: 0, errors: [CLOSING] }
  if (action === 'dates') {
    const files = await organize.applyDateFixes(organize.findDateFixes(visibleLibrary()))
    if (files.length) {
      history.add({ kind: 'dates', files })
      await retime(await newTimes(files.map((f) => f.from)))
    }
    return { done: files.length, errors: [] }
  }
  if (action === 'folders') {
    if (!o.root) return { done: 0, errors: ['Choose where the dated folders go first.'] }
    const plan = organize.planFolders(organize.organizeSource(kept, o.root, o.roots), o.root, o.folderPattern)
    // Moving into a folder outside the library: it becomes a library folder first (as Import's
    // destination does), so the scan after the move finds the photos there instead of dropping them
    // with their faces, names, tags and text.
    if (!o.copy && plan.length && !inLibraryFolders(o.root)) {
      try {
        await fs.promises.mkdir(o.root, { recursive: true })
      } catch {}
      await addFolders([o.root])
      if (!inLibraryFolders(o.root)) return { done: 0, errors: [`Couldn't add ${o.root} to your library folders, so nothing was moved.`] }
    }
    const res = await organize.executePlan(plan, { copy: o.copy, signal })
    ownFiles(res.files.map((f) => f.to))
    if (res.files.length) {
      history.add({ kind: o.copy ? 'copied' : 'moved', destination: o.root, files: res.files.map(({ id, ...f }) => f) })
      if (!o.copy) await relocate(res.files)
    }
    return { done: res.files.length, errors: res.errors }
  }
  if (action === 'rename') {
    const plan = organize.planRenames(kept, o.renamePattern, o.deviceNamesOnly)
    const res = await organize.executePlan(plan, { signal })
    ownFiles(res.files.map((f) => f.to))
    if (res.files.length) {
      history.add({ kind: 'renamed', files: res.files.map(({ id, ...f }) => f) })
      await relocate(res.files)
    }
    return { done: res.files.length, errors: res.errors }
  }
  if (action === 'convert') {
    const res = await organize.convertHeicFiles(kept.filter(organize.isHeic), (it) => thumbs.source(it), {
      quality: o.quality,
      originalsDir: o.moveOriginals ? originalsDir() : null,
      roots: o.roots,
      signal,
      onProgress: (done, total) => send('organize:progress', { done, total }),
    })
    ownFiles(res.files.map((f) => f.to))
    if (res.entry) {
      history.add(res.entry)
      await relocate(convertedPairs(res.entry), { history: false })
    }
    return { done: res.files.length, errors: res.errors }
  }
  return { done: 0, errors: ['Unknown action'] }
}

/** Turns JPEGs by quarter turns (orientation tag only). Resolves { done, errors }. */
ipcMain.handle('edit:rotate', async (_e, ids, turns) => {
  if (quitting) return { done: 0, errors: [CLOSING] }
  return fileJob(async (signal) => {
    const items = itemsFor(idList(ids)).filter((it) => isJpeg(it.ext))
    const q = Math.round(Number(turns)) || 0
    const files = []
    const errors = []
    await tags.hold(async () => {
      for (const it of items) {
        if (signal.aborted) break
        const res = await edits.rotate(it, q, backupsDir())
        if (res.error) errors.push(`${it.name}: ${res.error}`)
        else files.push(res.file)
      }
    })
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
})

/** Writes the date taken into a JPEG (EXIF, lossless) and sets its file date to match. */
ipcMain.handle('edit:date', async (_e, id, ms) => {
  const [it] = itemsFor(id)
  if (!it || !isJpeg(it.ext)) return { error: 'Only JPEG photos can be changed without re-saving them.' }
  const date = Number(ms)
  if (!Number.isFinite(date) || new Date(date).getFullYear() < 1900 || date > Date.now() + 86_400_000) return { error: 'That date looks wrong.' }
  if (quitting) return { error: CLOSING }
  return fileJob(async () => {
    const res = await tags.hold(() => edits.setDateTaken(it, date, backupsDir()))
    if (res.error) return { error: res.error }
    history.add({ kind: 'edited', note: `Date taken of ${it.name} set to ${new Date(date).toLocaleString()}`, files: [res.file] })
    await refreshEdited([it.path])
    return { ok: true }
  })
})

// ---------- duplicates & search ----------

ipcMain.handle('dupes:dismiss', (_e, ids) => dupes.dismiss(idList(ids)))
// ---------- private ----------

ipcMain.handle('private:add', (_e, ids) => priv.add(itemsFor(idList(ids)).map((it) => it.path)))
ipcMain.handle('private:remove', async (_e, ids) => {
  if (!priv.unlocked) return 0 // only someone who unlocked Private can make items public again
  const items = itemsFor(idList(ids))
  const res = await movePrivate(priv.vaultItems(items), 'out')
  const movedTo = new Map(res.files.map((f) => [keyOf(f.from), f.to]))
  return priv.remove(items.map((it) => movedTo.get(keyOf(it.path)) ?? it.path))
})
ipcMain.handle('private:hide', async (_e, ids) => {
  if (!priv.unlocked) return { done: 0, errors: ['Unlock Private first.'] }
  const res = await movePrivate(itemsFor(idList(ids)), 'in')
  return { done: res.files.length, errors: res.errors, folder: res.folders?.[0] ?? null }
})
ipcMain.handle('private:reset', async () => {
  // With Windows Hello there's always a way in. Asked again now: a glitch in an earlier check
  // must not open the way to wiping (and so showing) everything private.
  if (quitting || (await priv.checkHello()) === 'available') return false
  await movePrivate(priv.vaultItems(library.list), 'out')
  priv.reset()
  return true
})

/** Moves items into ('in') or out of the hidden private folder, recorded in History. */
async function movePrivate(items, way) {
  if (!items.length) return { files: [], errors: [] }
  if (quitting) return { files: [], errors: [CLOSING] }
  return fileJob(() => withScansHeld(async () => {
    const res = way === 'in' ? await priv.moveIntoVault(items) : await priv.moveOutOfVault(items)
    ownFiles(res.files.map((f) => f.to))
    if (res.files.length) {
      const n = res.files.length
      history.add({
        kind: 'moved',
        destination: way === 'in' ? res.folders?.[0] : undefined,
        note: way === 'in' ? `Hid ${n} private item${n === 1 ? '' : 's'} in File Explorer` : `Moved ${n} item${n === 1 ? '' : 's'} out of the hidden private folder`,
        files: res.files.map(({ id, ...f }) => f),
      })
      await relocate(res.files)
    }
    return res
  }))
}

// ---------- export & share ----------

const exports_ = exporter.registerIpc({
  ipcMain,
  dialog,
  shell,
  app,
  store,
  getWindow: () => win,
  itemsFor,
  getSource: (it) => thumbs.source(it),
  send,
  onWritten: (files) => ownFiles(Array.isArray(files) ? files : [files]),
})

// ---------- import (phones, cameras, cards, folders) ----------

// Only sources Pics listed (or the user picked) can be scanned: the UI never passes a path.
const importSources = new Map()
let importAbort = null
const importHashOf = (it) => {
  const r = dupes.records.get(it.id)
  return r && r.m === it.mtime && r.z === it.size ? r.x : undefined
}
const importOptions = (deleteAfter) => ({
  destination: store.get('importDestination') || store.get('folders')[0] || app.getPath('pictures'),
  folderPattern: store.get('importFolderPattern'),
  skipImported: store.get('importSkipKnown') !== false,
  convertHeic: !!store.get('importConvertHeic'),
  heicOriginals: store.get('importHeicOriginals') || 'aside',
  deleteAfter: !!deleteAfter,
})

ipcMain.handle('import:sources', async () => {
  try {
    const sources = await importer.listSources({ exclude: store.get('folders') })
    for (const s of sources) importSources.set(s.id, s)
    return { sources, error: null }
  } catch (err) {
    return { sources: [], error: String(err?.message ?? err) }
  }
})
ipcMain.handle('import:pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Import from a folder', properties: ['openDirectory'] })
  if (res.canceled || !res.filePaths[0]) return null
  const source = importer.folderSource(res.filePaths[0])
  importSources.set(source.id, source)
  return source
})
/**
 * A second scan or import while one runs is refused before it touches `importAbort`, so Cancel
 * still stops the one that's running.
 */
function refuseIfImporting() {
  if (importAbort || importer.busy) throw new Error(`Pics is still ${importer.busy || 'busy with an import'}.`)
  if (quitting) throw new Error(CLOSING)
}

ipcMain.handle('import:scan', async (_e, sourceId) => {
  const source = importSources.get(sourceId)
  if (!source) throw new Error('That device or folder is no longer available.')
  refuseIfImporting()
  const controller = (importAbort = new AbortController())
  try {
    return await importer.scan(source, {
      items: library.list,
      hashOf: importHashOf,
      skipExtensions: skippedExtensions(store.get('skippedTypes')),
      minBytes: store.get('minFileKB') * 1024,
      signal: controller.signal,
      onProgress: (p) => send('import:scan-progress', p),
    })
  } finally {
    if (importAbort === controller) importAbort = null
    send('import:scan-progress', null)
  }
})
ipcMain.handle('import:plan', (_e, scanId, deleteAfter) => importer.plan(scanId, importOptions(deleteAfter)))
ipcMain.handle('import:cancel', () => importAbort?.abort())
ipcMain.handle('import:forget', (_e, sourceId) => (typeof sourceId === 'string' ? importer.forget(sourceId) : 0))
ipcMain.handle('import:pick-destination', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Where should imported photos go?',
    defaultPath: importOptions().destination,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  store.set({ importDestination: res.filePaths[0] })
  send('settings:changed', settingsPayload())
  return res.filePaths[0]
})
ipcMain.handle('import:run', async (_e, scanId, deleteAfter) => {
  refuseIfImporting()
  return fileJob(async (signal, controller) => {
    importAbort = controller // (Cancel and quitting both stop it)
    try {
      const res = await withScansHeld(async () => {
        const r = await importer.run(scanId, {
          ...importOptions(deleteAfter),
          items: library.list,
          hashOf: importHashOf,
          quality: store.get('jpegQuality'),
          originalsDir: originalsDir(),
          heicSource: (it) => thumbs.source(it),
          trash: (p) => shell.trashItem(p),
          signal,
          onProgress: (p) => send('import:progress', p),
          // new files from an import aren't "new duplicates" (held folder events replay after it)
          onFile: (p) => alerts?.ignore([p], 10 * 60_000),
        })
        // a destination outside the library becomes a library folder before the scan that follows
        if (r.imported && r.destination && !inLibraryFolders(r.destination)) await addFolders([r.destination])
        return r
      })
      const entry = res.entry ? history.add(res.entry) : null
      const { files, entry: _entry, ...rest } = res
      return { ...rest, entryId: entry?.id ?? null }
    } finally {
      if (importAbort === controller) importAbort = null
      send('import:progress', null)
    }
  })
})

// ---------- ratings & tags ----------

ipcMain.handle('tags:rate', (_e, ids, rating) => tags.setRating(itemsFor(idList(ids)), Number(rating)))
ipcMain.handle('tags:edit', (_e, ids, change) => {
  const list = (a) => (Array.isArray(a) ? a.filter((t) => typeof t === 'string').slice(0, 200) : undefined)
  return tags.editTags(itemsFor(idList(ids)), { add: list(change?.add) ?? [], remove: list(change?.remove) ?? [], set: list(change?.set) })
})

// ---------- locations ----------

ipcMain.handle('locations:suggest', (_e, ids, hours) =>
  locSuggest.suggestLocations(itemsFor(idList(ids)), listed(), { window: Math.min(Math.max(Number(hours) || 3, 0.25), 72) * 3_600_000, places }),
)
ipcMain.handle('locations:search', (_e, q) => (typeof q === 'string' ? locSuggest.searchPlaces(places, q.slice(0, 100)) : []))
ipcMain.handle('locations:describe', (_e, lat, lon) => locSuggest.describe(places, Number(lat), Number(lon)))
ipcMain.handle('locations:set', async (_e, assignments, label) => {
  const targets = (Array.isArray(assignments) ? assignments : [])
    .map((a) => ({ item: itemsFor(a?.id)[0], lat: Number(a?.lat), lon: Number(a?.lon) }))
    .filter((t) => t.item)
  if (!targets.length) return { done: 0, kept: [], errors: [] }
  if (quitting) return { done: 0, kept: [], errors: [CLOSING] }
  return fileJob(() => setLocations(targets, label))
})

async function setLocations(targets, label) {
  ownFiles(targets.map((t) => t.item.path))
  // (held: the background rating/tag writer rewrites JPEGs too, and one of the two changes would be lost)
  const res = await tags.hold(() => assignLocations(targets, { store: userLocations, backupsDir: backupsDir() }))
  if (res.files.length) history.add({ kind: 'edited', note: historyNote(targets, typeof label === 'string' ? label.slice(0, 120) : ''), files: res.files })
  // Only the place changed, not the picture: keep previews, faces and search vectors; just update the entry
  // (with the new size, so the next scan doesn't read it again).
  for (const w of res.written) {
    const it = library.get(w.id)
    if (it) Object.assign(it, { size: w.size ?? it.size, meta: { ...it.meta, lat: w.lat, lon: w.lon } })
  }
  if (res.written.length) {
    library.emit('changed')
    library.save()
  }
  return { done: res.written.length + res.stored.length, kept: res.kept, errors: res.errors }
}

ipcMain.handle('ocr:search', (_e, q) => (typeof q === 'string' ? ocr.search(q.slice(0, 200)) : { ids: [], snippets: [], scores: [] }))
ipcMain.handle('ocr:hits', (_e, tokens) =>
  Array.isArray(tokens) ? ocr.tokenHits(tokens.filter((t) => typeof t === 'string').map((t) => t.slice(0, 64))) : [],
)
ipcMain.handle('ocr:text', (_e, id) => (typeof id === 'string' ? ocr.text(id) : null))
ipcMain.handle('smart:similar', (_e, id) => (typeof id === 'string' ? smart.similar(id) : { ids: [], scores: [] }))
ipcMain.handle('smart:search', (_e, query) => (typeof query === 'string' ? smart.search(query.slice(0, 200)) : { ids: [], scores: [] }))

ipcMain.handle('library:rescan', () => scan())

ipcMain.handle('folders:add', (_e, paths) => addFolders(paths))

ipcMain.handle('folders:remove', (_e, folder) => {
  store.set({ folders: store.get('folders').filter((f) => keyOf(f) !== keyOf(folder)) })
  configureDupes()
  send('settings:changed', settingsPayload())
  watchFolders()
  updateWatching()
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
  if (typeof patch.textSearch === 'boolean') {
    allowed.textSearch = patch.textSearch
    ocr.setEnabled(patch.textSearch)
  }
  if (Number.isFinite(patch.dupeSensitivity)) allowed.dupeSensitivity = Math.round(Math.min(99, Math.max(80, patch.dupeSensitivity)))
  if (typeof patch.findCrops === 'boolean') allowed.findCrops = patch.findCrops
  if (['best', 'sharpest', 'largest', 'oldest', 'newest'].includes(patch.keepRule)) allowed.keepRule = patch.keepRule
  if (Array.isArray(patch.protectedFolders)) allowed.protectedFolders = patch.protectedFolders.filter((p) => typeof p === 'string' && fs.existsSync(p))
  if (patch.moveDestination === null) allowed.moveDestination = null
  else if (typeof patch.moveDestination === 'string' && path.isAbsolute(patch.moveDestination)) {
    // (the old folder stays when this one would hide the library)
    const problem = moveDestinationProblem(patch.moveDestination)
    if (problem) refuseMoveDestination(problem)
    else allowed.moveDestination = patch.moveDestination
  }
  if (typeof patch.carryDates === 'boolean') allowed.carryDates = patch.carryDates
  if (Number.isFinite(patch.blurThreshold)) allowed.blurThreshold = Math.min(80, Math.max(5, Math.round(patch.blurThreshold)))
  if (Number.isFinite(patch.largeFileMB)) allowed.largeFileMB = Math.min(500, Math.max(5, Math.round(patch.largeFileMB)))
  if (organize.FOLDER_PATTERNS.some((p) => p.value === patch.folderPattern)) allowed.folderPattern = patch.folderPattern
  if (organize.NAME_PATTERNS.some((p) => p.value === patch.renamePattern)) allowed.renamePattern = patch.renamePattern
  if (typeof patch.organizeCopy === 'boolean') allowed.organizeCopy = patch.organizeCopy
  if (typeof patch.deviceNamesOnly === 'boolean') allowed.deviceNamesOnly = patch.deviceNamesOnly
  if (typeof patch.moveOriginals === 'boolean') allowed.moveOriginals = patch.moveOriginals
  if (Number.isFinite(patch.jpegQuality)) allowed.jpegQuality = Math.min(100, Math.max(70, Math.round(patch.jpegQuality)))
  if (patch.organizeRoot === null) allowed.organizeRoot = null
  if (organize.FOLDER_PATTERNS.some((p) => p.value === patch.importFolderPattern)) allowed.importFolderPattern = patch.importFolderPattern
  if (typeof patch.importSkipKnown === 'boolean') allowed.importSkipKnown = patch.importSkipKnown
  if (typeof patch.importConvertHeic === 'boolean') allowed.importConvertHeic = patch.importConvertHeic
  if (['aside', 'next', 'none'].includes(patch.importHeicOriginals)) allowed.importHeicOriginals = patch.importHeicOriginals
  if (patch.importDestination === null) allowed.importDestination = null
  if (typeof patch.tagsInFiles === 'boolean') allowed.tagsInFiles = patch.tagsInFiles
  if (typeof patch.xmpSidecars === 'boolean') allowed.xmpSidecars = patch.xmpSidecars
  if (typeof patch.watchFolders === 'boolean') allowed.watchFolders = patch.watchFolders
  if (typeof patch.minimizeToTray === 'boolean') allowed.minimizeToTray = patch.minimizeToTray
  if (Array.isArray(patch.skippedFolders)) {
    const seen = new Set()
    allowed.skippedFolders = patch.skippedFolders.filter((p) => {
      if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p) || seen.has(keyOf(p))) return false
      seen.add(keyOf(p))
      return true
    })
  }
  if (Array.isArray(patch.skippedTypes)) allowed.skippedTypes = patch.skippedTypes.filter((k) => FILE_TYPES.some((t) => t.key === k))
  if (Number.isFinite(patch.minFileKB)) allowed.minFileKB = Math.min(500, Math.max(0, Math.round(patch.minFileKB / 10) * 10))
  store.set(allowed)
  if ('watchFolders' in allowed) updateWatching()
  if ('tagsInFiles' in allowed || 'xmpSidecars' in allowed) tags.configure({ writeFiles: store.get('tagsInFiles') !== false, sidecars: !!store.get('xmpSidecars') })
  if ('skippedFolders' in allowed || 'skippedTypes' in allowed || 'minFileKB' in allowed) scan()
  if ('dupeSensitivity' in allowed || 'findCrops' in allowed) configureDupes()
  if ('moveDestination' in allowed) scan()
  if (allowed.theme) applyTheme()
  send('settings:changed', settingsPayload())
})

ipcMain.handle('system:context-menu', async (_e, on) => {
  try {
    await bgx.setContextMenu(!!on)
    contextMenuOn = await bgx.isContextMenuEnabled()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  } finally {
    send('settings:changed', settingsPayload())
  }
})
ipcMain.handle('system:startup', (_e, on) => {
  try {
    bgx.startWithWindows(!!on)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  } finally {
    send('settings:changed', settingsPayload())
  }
})

ipcMain.handle('favorites:set', (_e, ids, value) => setFavorites(ids, !!value))

/** Files that left the library (moved away or recycled): drop them everywhere. */
function forgetItems(ids) {
  if (!ids.length) return
  setFavorites(ids, false)
  library.remove(ids)
  faces.removeItems(ids)
  albums.forget(ids)
  tags.forget(ids)
  // (until the library knows every folder's items, the next full scan does this: see 'scanned')
  if (!libraryComplete) {
    indexesStale = true
    return
  }
  smart.sync(visibleLibrary())
  ocr.sync(visibleLibrary())
  dupes.sync(visibleLibrary())
}

/**
 * Recycle Bin or move to a folder. Before removing, kept copies in the same duplicate groups can
 * get the original's date (carry dates). Every action is recorded in History.
 */
async function removeItems(ids, how, dest) {
  const items = itemsFor(idList(ids))
  if (!items.length) return { removed: 0, failed: 0, errors: [] }
  const destination = how === 'move' ? dest || moveDestination() : undefined
  const refuse = (message) => ({ removed: 0, failed: items.length, errors: [message], entryId: null, destination })
  if (quitting) return refuse(CLOSING)
  // (a folder that would hide the library from scans, even one saved before this was checked)
  const problem = how === 'move' ? moveDestinationProblem(destination) : null
  if (problem) {
    refuseMoveDestination(problem)
    return refuse(problem)
  }
  return fileJob(async (signal) => {
    const removing = new Set(items.map((it) => it.id))
    const byId = new Map(library.list.map((it) => [it.id, it]))
    const dateChanges = store.get('carryDates') !== false ? await cleanup.carryDates(dupes.groupsOf([...removing]), removing, byId) : []
    if (dateChanges.length) await retime(await newTimes(dateChanges.map((c) => c.path)))
    let kept = null
    const res = await tags.hold(async () => {
      // what forgetItems() drops, so undoing the move can put it back (taken before the move: a scan
      // finishing meanwhile could drop the moved files' Pics-only ratings and tags)
      if (how === 'move') kept = rememberForUndo(items)
      return how === 'move' ? cleanup.moveTo(items, destination, { signal }) : cleanup.recycle(items, { signal })
    })
    let entry = null
    if (res.files.length || dateChanges.length) {
      const moved = kept ? keptFor(kept, res.files.map((f) => f.from)) : null
      entry = history.add({
        kind: how === 'move' ? 'moved' : 'recycled',
        destination,
        files: res.files.map(({ id, ...f }) => f),
        dateChanges,
        ...(moved && { forgotten: moved }),
      })
    }
    forgetItems(res.files.map((f) => f.id))
    // (`notes`: files that moved but whose XMP sidecar stayed behind; not failures)
    return { removed: res.files.length, failed: res.errors.length, errors: res.errors, notes: res.notes ?? [], entryId: entry?.id ?? null, destination }
  })
}

/**
 * Favorites, album memberships and Pics-only ratings/tags of items about to leave the library
 * (forgetItems drops them): { favorites: [path], albums: [{ id, paths, cover? }], tags: [[path, entries]] }.
 */
function rememberForUndo(items) {
  const paths = items.map((it) => it.path)
  const want = new Set(paths.map(keyOf))
  return {
    favorites: store.get('favorites').filter((p) => want.has(keyOf(p))),
    albums: albums.membershipsOf(paths),
    // one path at a time, so each file's entries can be told apart later
    tags: paths.map((p) => [p, tags.snapshot([p])]).filter(([, e]) => Array.isArray(e) && e.length),
    // faces moved by hand, "not this person", covers, faces of named people (and those people)
    faces: faces.snapshotChoices(items.map((it) => it.id)),
  }
}

/** Only what belongs to `paths` (the files that really moved); null when there's nothing. */
function keptFor(kept, paths) {
  const want = new Set(paths.map(keyOf))
  const out = {
    favorites: kept.favorites.filter((p) => want.has(keyOf(p))),
    albums: kept.albums.map((m) => ({ ...m, paths: m.paths.filter((p) => want.has(keyOf(p))) })).filter((m) => m.paths.length || (m.cover && want.has(keyOf(m.cover)))),
    tags: kept.tags.filter(([p]) => want.has(keyOf(p))),
    faces: facesFor(kept.faces, new Set(paths.map(idOf))),
  }
  return out.favorites.length || out.albums.length || out.tags.length || out.faces ? out : null
}

/** The face choices of the photos with these ids only (null when none). */
function facesFor(snap, ids) {
  if (!snap?.choices) return null
  const choices = Object.fromEntries(Object.entries(snap.choices).filter(([id]) => ids.has(id)))
  return Object.keys(choices).length ? { choices, people: snap.people ?? [] } : null
}

/** Undo of a Clean up move: the files of `paths` that are back get their favorite, albums, ratings, tags and face choices back. */
function restoreForgotten(forgotten, paths) {
  if (!forgotten || !paths.length) return
  const back = new Set(paths.map(keyOf))
  const favs = (Array.isArray(forgotten.favorites) ? forgotten.favorites : []).filter((p) => typeof p === 'string' && back.has(keyOf(p)))
  if (favs.length) {
    const current = new Map(store.get('favorites').map((p) => [keyOf(p), p]))
    for (const p of favs) current.set(keyOf(p), p)
    store.set({ favorites: [...current.values()] })
    send('settings:changed', settingsPayload())
  }
  albums.restoreMemberships(forgotten.albums, paths)
  const entries = (Array.isArray(forgotten.tags) ? forgotten.tags : [])
    .filter((t) => Array.isArray(t) && typeof t[0] === 'string' && back.has(keyOf(t[0])) && Array.isArray(t[1]))
    .flatMap(([, e]) => e)
  if (entries.length) tags.restoreEntries(entries)
  const faceChoices = facesFor(forgotten.faces, new Set(paths.map(idOf)))
  if (faceChoices) faces.restoreChoices(faceChoices)
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
  const problem = moveDestinationProblem(res.filePaths[0])
  if (problem) {
    await refuseMoveDestination(problem) // (the folder chosen before stays)
    return null
  }
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
  if (quitting) return { restored: 0, total: entry.files.length }
  return fileJob(() => restoreEntry(entry))
})

async function restoreEntry(entry) {
  let restored = 0
  let kept
  let renamed
  if (entry.kind === 'edited') {
    // (held: the background rating/tag writer must not rewrite a photo while its original goes back)
    const done = await tags.hold(() => edits.restoreBackups(entry.files))
    restored = done.length + userLocations.revert(entry.files)
    // A different photo has the edited one's place now: the original came back next to it under a
    // new name ("IMG_1 (2).jpg", `restoredAs`) and that other photo was left as it was.
    const inPlace = done.filter((f) => !f.restoredAs)
    const beside = done.filter((f) => f.restoredAs)
    renamed = beside.length
    // the original doesn't hold the rating and tags set since (never written into the other photo)
    if (inPlace.length) tags.rewrite(inPlace.map((f) => f.from))
    if (done.length) await refreshEdited([...inPlace.map((f) => f.from), ...beside.map((f) => f.restoredAs)])
  } else if (entry.kind === 'imported') {
    restored = await importer.undo(entry, (p) => shell.trashItem(p))
    kept = entry.keptOnUndo ?? 0
  } else if (['moved', 'renamed', 'converted', 'dates'].includes(entry.kind)) {
    await withScansHeld(async () => {
      if (entry.kind === 'moved' || entry.kind === 'renamed') {
        const pending = entry.files.filter((f) => !f.restored)
        ownFiles(pending.map((f) => f.from))
        restored = await cleanup.restoreMoves(entry.files)
        const back = pending.filter((f) => f.restored)
        await relocate(back.map((f) => ({ from: f.to, to: f.from, ...(f.sidecar && { sidecar: { from: f.sidecar.to, to: f.sidecar.from } }) })))
        // a Clean up move: favorites, albums, ratings and tags dropped when the files left come back
        if (entry.forgotten) restoreForgotten(entry.forgotten, back.map((f) => f.from))
        const dated = (entry.dateChanges ?? []).filter((c) => !c.restored)
        if (await cleanup.restoreDates(entry.dateChanges)) await retime(await newTimes(dated.filter((c) => c.restored).map((c) => c.path)))
      } else if (entry.kind === 'converted') {
        const pending = entry.files.filter((f) => !f.restored)
        ownFiles((entry.movedOriginals ?? []).map((m) => m.from))
        restored = await organize.undoConversion(entry, (p) => shell.trashItem(p))
        const back = convertedPairs({ ...entry, files: pending.filter((f) => f.restored) })
        await relocate(
          back.map((p) => ({ from: p.to, to: p.from })),
          { history: false },
        )
      } else {
        const done = []
        for (const f of entry.files) {
          if (f.restored || !Number.isFinite(f.oldMtime)) continue
          try {
            await cleanup.setFileDate(f.from, f.oldMtime)
            f.restored = true
            done.push(f.from)
            restored++
          } catch {}
        }
        await retime(await newTimes(done))
      }
    })
  }
  history.changed(entry)
  if (restored && !quitting) scan()
  // (an import's undo keeps the copies whose originals left the card, and any that changed since)
  // (`renamed`: originals of edits that came back under a new name, next to the photo now at their place)
  return { restored, total: entry.files.length, ...(kept !== undefined && { kept }), ...(renamed && { renamed }) }
}
ipcMain.handle('shell:recycle-bin', () => {
  if (process.platform === 'win32') require('node:child_process').spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' }).unref()
})

// ---------- reports ----------

ipcMain.handle('report:save', async (_e, html, csv) => {
  if (typeof html !== 'string' || typeof csv !== 'string') return null
  const stamp = new Date().toISOString().slice(0, 10)
  const res = await dialog.showSaveDialog(win, {
    title: 'Export a report',
    defaultPath: path.join(app.getPath('documents'), `Pics report ${stamp}.html`),
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

// (only a folder is opened; for a file, Explorer shows it: opening one would run an .exe, .bat or .lnk)
ipcMain.handle('folders:reveal', (_e, dir) => {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return
  let st = null
  try {
    st = fs.statSync(dir)
  } catch {
    return
  }
  if (st.isDirectory()) shell.openPath(dir)
  else shell.showItemInFolder(dir)
})

/**
 * Puts a photo on the clipboard. Windows' own image reader (nativeImage) only knows PNG and JPEG,
 * so the picture is decoded the way the editor does (HEIC, WebP, RAW… through thumbs.source), turned
 * upright and handed over as PNG. Resolves false (the clipboard is left as it was) when that fails.
 */
async function copyImage(item) {
  if (item?.type !== 'image') return false
  try {
    const sharp = require('sharp')
    let source = await thumbs.source(item).catch(() => null)
    if (!source) source = await thumbs.get(item, 'preview').catch(() => null)
    if (!source) return false
    const png = await sharp(source, { failOn: 'none' }).rotate().png({ compressionLevel: 1 }).toBuffer()
    const image = nativeImage.createFromBuffer(png)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  } catch {
    return false
  }
}

ipcMain.handle('items:copy', async (_e, id, kind) => {
  const [item] = itemsFor(id)
  if (!item) return false
  if (kind === 'path') {
    clipboard.writeText(item.path)
    return true
  }
  return copyImage(item)
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
          ...(smart.hasVector(item.id) ? [{ label: 'Find similar', click: action('similar') }] : []),
          { type: 'separator' },
        ]),
    {
      label: allFav ? 'Remove from favorites' : multi ? `Add ${targets.length} to favorites` : 'Add to favorites',
      click: () => setFavorites(targets, !allFav),
    },
    { label: multi ? `Add ${targets.length} to album…` : 'Add to album…', click: action('album') },
    { label: multi ? `Export ${targets.length}…` : 'Export…', click: action('export') },
    priv.isPrivate(item.path)
      ? { label: multi ? `Remove ${targets.length} from Private` : 'Remove from Private', click: action('unprivate') }
      : { label: multi ? `Move ${targets.length} to Private` : 'Move to Private', click: action('private') },
    { label: multi ? `Set location of ${targets.length}…` : item.meta?.lat !== undefined ? 'Change location…' : 'Add location…', click: action('location') },
    ...(multi
      ? []
      : [
          ...(item.type === 'image'
            ? [
                {
                  label: 'Copy image',
                  click: () =>
                    copyImage(item).then((ok) => {
                      if (!ok) messageBox({ type: 'warning', title: 'Pics', message: "Couldn't copy this image", detail: `${item.name} couldn't be read as a picture. The clipboard wasn't changed.`, buttons: ['OK'] })
                    }),
                },
              ]
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
  // (a WebP thumbnail reads as empty here: Windows needs an icon to show, so Pics' own goes instead)
  if (icon.isEmpty()) icon = nativeImage.createFromPath(ICON)
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
  thumbs.prefetch(visibleLibrary())
})

ipcMain.handle('shell:url', (_e, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url)
})

// ---------- lifecycle ----------

nativeTheme.on('updated', () => {
  if (win && !IS_MAC) win.setTitleBarOverlay(overlay())
})

app.on('second-instance', (_event, argv, cwd, data) => {
  trace(`second launch (v${data?.version}) · window ${win ? 'open' : 'none'}`)
  if (data?.version && isNewer(data.version, VERSION)) {
    // A newer Pics was just launched: close so it can take over.
    app.quit()
    return
  }
  const args = bgx.parseArgs(argv, { cwd })
  if (args.tray && !args.folder) return // started with Windows again: already running
  if (quitting) {
    // Pics was opened again while this copy finishes quitting (a file job, the last saves): it
    // can't take this launch any more, so a new copy starts the moment this one has exited.
    if (!relaunchAsked) {
      relaunchAsked = true
      const keep = process.argv.slice(1).filter((a) => a !== '--tray' && a !== '--autoscan')
      app.relaunch({ args: [...keep, ...(args.folder ? ['--folder', args.folder] : []), ...(args.autoscan ? ['--autoscan'] : [])] })
    }
    return
  }
  // No window (e.g. still starting, or hidden in the notification area): open one.
  showWindow()
  if (args.folder) servicesReady.then(() => openFolder(args.folder))
  if (args.autoscan) {
    servicesReady.then(() => {
      scan()
      showDuplicates()
    })
  }
})

/** instance.json: which Pics runs (for a newer one launching), plus `extra` (e.g. finishingUntil). */
function writeInstanceFile(extra = {}) {
  try {
    fs.writeFileSync(INSTANCE_FILE, JSON.stringify({ version: VERSION, pid: process.pid, ...extra }))
  } catch {}
}

app.whenReady().then(async () => {
  if (!(await singleInstance)) return
  writeInstanceFile()
  if (process.platform === 'win32') app.setAppUserModelId('app.lumen.gallery')
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://tile.openstreetmap.org/*'] }, (details, done) => {
    done({ requestHeaders: { ...details.requestHeaders, 'User-Agent': `Pics/${VERSION} (Windows photo gallery)` } })
  })
  Menu.setApplicationMenu(null)
  startServices()
  handleProtocol({
    // a locked private item can't be shown, even by id
    library: {
      get: (id) => {
        const it = library.get(id)
        return it && !priv.unlocked && priv.isPrivate(it.path) ? undefined : it
      },
    },
    thumbs,
    importItem: (id) => importer.thumbItem(id),
  })
  // Started with Windows to keep watching: stay in the notification area until opened.
  const startHidden = launchArgs.tray && !launchArgs.folder && !!store.get('watchFolders')
  // Otherwise show the window right away; the saved library, faces, albums… load meanwhile (~0.5 s).
  if (!startHidden) createWindow()
  bgx.isContextMenuEnabled().then(
    (on) => {
      contextMenuOn = on
      // follow an updated install (and "Scan with Lumen" becomes "Scan with Pics")
      if (on && app.isPackaged) bgx.refreshContextMenu().catch(() => {})
    },
    () => {},
  )
  // "Start with Windows" naming the old program file (Lumen.exe before the rename): point it here
  if (app.isPackaged) {
    try {
      if (bgx.refreshStartWithWindows()) trace('start with Windows: now starts this copy')
    } catch {}
  }
  // A photo rewrite (rating, tags, rotation, date, location) cut short last time, by a crash or a
  // forced exit, can leave the photo only as "name.jpg.lumen.old": put it back before anything
  // reads the library folders.
  try {
    setSwapJournal(path.join(userData, 'pending-swaps.json'))
    const swaps = await recoverSwaps()
    const keptCopies = Array.isArray(swaps?.kept) ? swaps.kept.filter((p) => typeof p === 'string') : []
    if (swaps?.restored || swaps?.cleaned || keptCopies.length) {
      trace(`photo rewrites recovered: ${swaps.restored} put back, ${swaps.cleaned} tidied, ${keptCopies.length} kept as copies`)
    }
    if (keptCopies.length) {
      // Pics' own files (not new duplicates); said once, since they now show in the library
      ownFiles(keptCopies)
      for (const p of keptCopies) trace(`kept as a copy: ${p}`)
      const shown = keptCopies.slice(0, 8).join('\n') + (keptCopies.length > 8 ? `\n…and ${keptCopies.length - 8} more` : '')
      messageBox({
        type: 'info',
        title: 'Pics',
        message: `${keptCopies.length === 1 ? 'A photo' : `${keptCopies.length} photos`} from an unfinished change ${keptCopies.length === 1 ? 'was' : 'were'} kept as ${keptCopies.length === 1 ? 'a copy' : 'copies'}`,
        detail: `Last time Pics closed while changing a photo, and the earlier version wasn't the same picture, so it was kept next to the photo instead of being deleted:\n\n${shown}\n\nCheck ${keptCopies.length === 1 ? 'it' : 'them'} and delete what you don't need.`,
        buttons: ['OK'],
      })
    }
  } catch (err) {
    console.error("Couldn't check for photo rewrites left over from last time", err)
  }
  // (ocr.load: without it every launch read the text of every photo again, for an hour or more)
  await Promise.all([library.load(), faces.load(), albums.load(), dupes.load(), smart.load(), ocr.load(), history.load(), userLocations.load(), tags.load(), priv.load()])
  dataLoaded = true
  placesData = places.group(listed())
  if (launchArgs.folder) await openFolder(launchArgs.folder)
  if (launchArgs.autoscan) showDuplicates()
  markServicesReady()
  tags.resume() // writes left over from last time
  trace(`data loaded: ${library.list.length} items (library ${library.loadState})`)
  thumbs.prefetch(visibleLibrary())
  libraryComplete = library.loadState === 'ok'
  if (libraryComplete) {
    faces.sync(visibleLibrary())
    smart.sync(visibleLibrary())
    ocr.sync(visibleLibrary())
    dupes.sync(visibleLibrary())
  } else {
    // No saved library to go by (first run, or library.json damaged or unreadable): syncing the
    // analyses with an empty list would drop every face, name and fingerprint. The first scan's
    // 'scanned' event syncs them with what is really there.
    indexesStale = true
  }
  // memory-movie work folders left by a crash or a forced exit
  Promise.resolve()
    .then(() => ffmpeg.sweepStaleTemps())
    .catch(() => {})
  watchFolders()
  scan()
  updateWatching()
  if (startHidden && !alerts.watching) showWindow()

  app.on('activate', () => {
    if (!win) createWindow()
  })
})

app.on('window-all-closed', () => {
  trace('all windows closed')
  if (ownsInstance) store.saveNow()
  if (!IS_MAC) app.quit()
})

/** Quitting has started (no new file job starts; closing the window no longer hides it in the tray). */
let quitting = false
/** The file jobs are done and the background saves finished (or ran out of time): the next quit goes through. */
let readyToQuit = false
let savedAtQuit = false
/** A launch came in while quitting: a new copy starts once this one has exited. */
let relaunchAsked = false

// How long quitting waits for each step. Whatever happens, the process ends after all of them.
const JOBS_LIMIT_MS = 60_000
const TAGS_LIMIT_MS = 10_000
const SAVES_LIMIT_MS = 5_000
const QUIT_LIMIT_MS = JOBS_LIMIT_MS + TAGS_LIMIT_MS + SAVES_LIMIT_MS + 10_000

/** Resolves 'done', 'failed' or 'timeout': when `promise` settles or after `ms`. Never rejects. */
const settleWithin = (promise, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    Promise.resolve(promise).then(
      () => (clearTimeout(timer), resolve('done')),
      () => (clearTimeout(timer), resolve('failed')),
    )
  })

/**
 * Before quitting: stops the running file jobs (after their current file) and waits until each has
 * recorded what it did in History and carried albums, favorites, faces, private marks… over to the
 * new paths; then for the rating/tag writes still queued and the saves that run in the background.
 * Every wait has a limit, so this always ends.
 */
async function finishBeforeQuit() {
  // a newer Pics that is taking over waits for this instead of ending it after 5 s
  writeInstanceFile({ finishingUntil: Date.now() + QUIT_LIMIT_MS })
  // jobs that only make new files just stop (their temp files go at the end)
  videoJob?.abort()
  movieJob?.abort()
  exports_.cancel()
  importAbort?.abort() // (an import, or an import scan)
  const jobs = [...fileJobs]
  let stuck = false
  if (jobs.length) {
    trace(`quitting: stopping ${jobs.length} file job${jobs.length === 1 ? '' : 's'}`)
    for (const job of jobs) job.controller.abort()
    stuck = (await settleWithin(Promise.allSettled(jobs.map((j) => j.done)), JOBS_LIMIT_MS)) === 'timeout'
    trace(stuck ? `file jobs still running after ${JOBS_LIMIT_MS / 1000} s` : 'file jobs finished')
  }
  // (a stuck job may be holding the tag writer: then there's no point waiting for it)
  if (tags && !stuck) {
    const how = await settleWithin(tags.flush(), TAGS_LIMIT_MS)
    if (how === 'timeout') trace(`rating/tag writes still queued after ${TAGS_LIMIT_MS / 1000} s (they're retried next time)`)
  }
  // (only what has changed: nothing is written over files that haven't even been loaded yet)
  await settleWithin(
    Promise.allSettled([history?.flush(), userLocations?.flush(), albums?.flush(), jobs.length && dataLoaded ? library.save() : null]),
    SAVES_LIMIT_MS,
  )
}

app.on('before-quit', (e) => {
  if (!ownsInstance) return
  if (!readyToQuit) {
    // First finish the file jobs and the background saves, then quit again for real.
    e.preventDefault()
    if (quitting) return
    quitting = true
    trace('quitting: finishing file jobs and saves')
    // Never linger invisibly in the background (that blocks the next launch): exit for real at the latest then.
    setTimeout(() => {
      trace(`still running ${QUIT_LIMIT_MS / 1000} s after quitting started: forcing exit`)
      app.exit(0)
    }, QUIT_LIMIT_MS).unref()
    finishBeforeQuit()
      .catch((err) => trace(`finishing before quit failed: ${err?.message ?? err}`))
      .finally(() => {
        readyToQuit = true
        app.quit()
      })
    return
  }
  if (savedAtQuit) return
  savedAtQuit = true
  trace('quitting: saving and stopping background work')
  store.saveNow()
  thumbs?.dispose()
  faces?.dispose()
  smart?.dispose()
  ocr?.dispose()
  dupes?.dispose()
  tags?.saveNow()
  importer?.dispose()
  priv?.dispose()
  eraser?.dispose()
  videoJob?.abort()
  movieJob?.abort()
  exports_.cancel()
  // temp and .part files of video jobs that were stopped
  try {
    ffmpeg.cleanupTempsSync()
  } catch {}
  alerts?.dispose()
  background?.dispose()
  albums?.saveNow()
  userLocations?.saveNow()
  history?.saveNow()
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
