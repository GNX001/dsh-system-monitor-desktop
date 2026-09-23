import { BrowserWindow, Menu, app, desktopCapturer, globalShortcut, ipcMain, nativeTheme, screen } from 'electron'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMonitor } from '../shared/metrics/monitor.js'
import { resolveLanguage, stringsFor } from '../shared/strings.js'
import {
  clampFloatingPosition,
  defaultFloatingPosition,
  dockedBounds,
  initialDockState,
  reduceDockState,
  resolveWorkArea,
} from './docking.js'
import { DEFAULT_SETTINGS, SETTINGS_FILE, normalizeSettings } from './settings.js'
import { readJson, writeJson } from './store.js'
import { createTray } from './tray.js'

/**
 * dsh-system-monitor-desktop — Windows standalone build.
 *
 * A frameless, transparent, always-on-top status bar. Pinned, it docks to the
 * top edge of the work area and auto-hides there, sliding back down when the
 * pointer reaches for it. It can also be put into click-through, so the mouse
 * acts on whatever is behind it.
 *
 * The bar is *not* hover-driven: hidden, it is almost entirely off-screen and
 * the OS delivers no events to it, so reveal is decided from the global cursor
 * position (`screen.getCursorScreenPoint`) — which keeps working even while
 * click-through is on.
 */

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..', '..')
const assetsDir = join(appRoot, 'assets')
const rendererFile = join(appRoot, 'src', 'renderer', 'index.html')
const preloadFile = join(here, '..', 'preload', 'index.cjs')

/** Fallback content size, replaced by whatever the renderer measures. Wide
 *  enough that the first layout has room to report its true width from. */
const FALLBACK_SIZE = { width: 900, height: 34 }
/** How often the dock state is re-evaluated. Cheap: one cursor read. */
const DOCK_POLL_MS = 100
/** How often a fresh snapshot is pushed to the renderer. */
const METRICS_PUSH_MS = 1000
/** Escape hatch for click-through, which otherwise leaves the bar unclickable. */
const CLICK_THROUGH_SHORTCUTS = ['CommandOrControl+Alt+L', 'CommandOrControl+Alt+B', 'CommandOrControl+Alt+Y']

/** Folders the app may write to, resolved lazily once `app` is ready. */
const settingsFile = () => join(app.getPath('userData'), SETTINGS_FILE)

let win = null
let trayHandle = null
let monitor = null
let stopMonitor = null
let dockTimer = null
let pushTimer = null
let settings = { ...DEFAULT_SETTINGS }
let dockState = initialDockState(Date.now())
let barSize = { ...FALLBACK_SIZE }
let quitting = false
/**
 * Suppresses the `moved` handler until this timestamp.
 *
 * `moved` arrives *after* `setBounds` returns, so a plain "am I inside setBounds?"
 * flag is already cleared by the time it fires — and a stale event from a docking
 * transition would then be treated as a user drag and overwrite the position.
 * A short deadline covers the round trip instead.
 */
let programmaticMoveUntil = 0
let strings = stringsFor('en')
let language = 'en'
let activeShortcut = null

/** Capture mode: `--capture[=dir]` walks the states and saves PNGs, then exits. */
const captureArg = process.argv.find((arg) => arg === '--capture' || arg.startsWith('--capture='))
const captureDir = captureArg === undefined ? null : captureArg.includes('=') ? captureArg.split('=')[1] : join(appRoot, 'capture')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- settings -----------------------------------------------------------------

async function loadSettings() {
  settings = normalizeSettings(await readJson(settingsFile(), DEFAULT_SETTINGS))
}

let persistTimer = null
function persistSettings() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    void writeJson(settingsFile(), settings)
  }, 250)
}

function updateSettings(patch) {
  settings = normalizeSettings({ ...settings, ...patch })
  persistSettings()
  trayHandle?.refresh()
  broadcastState()
}

// --- window -------------------------------------------------------------------

function workAreaFor(bounds) {
  return resolveWorkArea(screen.getAllDisplays(), bounds, screen.getPrimaryDisplay())
}

/**
 * Single place that decides where the window goes: docked (full width, top edge,
 * expanded or hidden) or floating (its own size, at its remembered position).
 */
function applyBounds() {
  if (win === null || win.isDestroyed()) return
  const workArea = workAreaFor(win.getBounds())
  programmaticMoveUntil = Date.now() + 300
  if (settings.pinned) {
    win.setBounds(dockedBounds(workArea, barSize.height, dockState.expanded))
    return
  }
  const size = { width: barSize.width, height: barSize.height }
  const wanted = settings.position ?? defaultFloatingPosition(size, workArea)
  win.setBounds({ ...clampFloatingPosition(wanted, size, workArea), ...size })
}

function applyAlwaysOnTop() {
  if (win === null || win.isDestroyed()) return
  // 'screen-saver' keeps the bar above ordinary windows and above most
  // full-screen apps, which is what "always on top" means for a widget.
  win.setAlwaysOnTop(settings.alwaysOnTop, settings.alwaysOnTop ? 'screen-saver' : 'normal')
}

function applyClickThrough() {
  if (win === null || win.isDestroyed()) return
  // `forward` keeps move events flowing to the renderer, so the bar can still
  // tell it is being hovered even though clicks pass through.
  win.setIgnoreMouseEvents(settings.clickThrough, { forward: true })
}

function applyVisibility(visible) {
  if (win === null || win.isDestroyed()) return
  if (visible) {
    win.showInactive()
    applyBounds()
  } else {
    win.hide()
  }
  trayHandle?.refresh()
}

function statePayload() {
  return {
    pinned: settings.pinned,
    expanded: dockState.expanded,
    clickThrough: settings.clickThrough,
    alwaysOnTop: settings.alwaysOnTop,
    dark: nativeTheme.shouldUseDarkColors,
    language,
    visible: win !== null && !win.isDestroyed() ? win.isVisible() : false,
  }
}

function broadcastState() {
  if (win === null || win.isDestroyed()) return
  win.webContents.send('bar:state', statePayload())
}

function createWindow() {
  win = new BrowserWindow({
    ...FALLBACK_SIZE,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: settings.alwaysOnTop,
    show: false,
    title: strings.appName,
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  Menu.setApplicationMenu(null)

  win.once('ready-to-show', () => {
    applyBounds()
    applyAlwaysOnTop()
    applyClickThrough()
    // Shown even in capture mode: the screen grabs are only meaningful if the bar
    // is really on screen, which is the whole point of checking docking.
    win.showInactive()
  })

  win.on('moved', () => {
    // Docked, the position is the dock's business; during a programmatic move the
    // event is our own echo, not a drag.
    if (settings.pinned || Date.now() < programmaticMoveUntil) return
    const bounds = win.getBounds()
    const workArea = workAreaFor(bounds)
    const clamped = clampFloatingPosition({ x: bounds.x, y: bounds.y }, { width: bounds.width, height: bounds.height }, workArea)
    if (clamped.x !== bounds.x || clamped.y !== bounds.y) {
      applyBounds()
      return
    }
    settings.position = clamped
    persistSettings()
  })

  // The ✕ button hides the bar; quitting is the tray's job, so a stray click
  // cannot lose the app (and the only way back from click-through).
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
    trayHandle?.refresh()
  })

  win.webContents.on('did-finish-load', () => {
    broadcastState()
    void pushSnapshot()
  })

  void win.loadFile(rendererFile)
}

// --- metrics ------------------------------------------------------------------

function startMetrics() {
  // CPU temperature and network each need a helper process, so they run on
  // slower cadences than the in-process CPU/memory counters.
  monitor = createMonitor({ tickMs: 1000, gpuMs: 1500, cpuTemperatureMs: 4000, networkMs: 2000 })
  stopMonitor = monitor.start()
  pushTimer = setInterval(() => void pushSnapshot(), METRICS_PUSH_MS)
  pushTimer.unref?.()
}

async function pushSnapshot(force = false) {
  if (monitor === null || win === null || win.isDestroyed()) return null
  const snapshot = force ? await monitor.refresh() : monitor.snapshot()
  if (!win.isDestroyed()) win.webContents.send('metrics:snapshot', snapshot)
  return snapshot
}

// --- docking ------------------------------------------------------------------

function startDocking() {
  dockTimer = setInterval(() => {
    if (win === null || win.isDestroyed() || !settings.pinned) return
    const bounds = win.getBounds()
    const workArea = workAreaFor(bounds)
    const cursor = screen.getCursorScreenPoint()
    const next = reduceDockState(dockState, {
      cursor,
      workArea,
      barHeight: barSize.height,
      now: Date.now(),
      pinned: true,
    })
    if (next === dockState) return
    const expandedChanged = next.expanded !== dockState.expanded
    dockState = next
    if (expandedChanged) {
      applyBounds()
      broadcastState()
    }
  }, DOCK_POLL_MS)
  dockTimer.unref?.()
}

// --- actions ------------------------------------------------------------------

function setPinned(pinned) {
  if (settings.pinned === pinned) return
  // Pinning always starts shown, so the bar never disappears the instant it is
  // pinned with the pointer somewhere else.
  dockState = initialDockState(Date.now())
  if (!pinned) {
    const bounds = win?.getBounds()
    const position = bounds === undefined ? settings.position : { x: bounds.x, y: bounds.y }
    updateSettings({ pinned, position })
    applyBounds()
    broadcastState()
    return
  }
  updateSettings({ pinned })
  applyBounds()
  broadcastState()
}

function setClickThrough(on) {
  updateSettings({ clickThrough: on })
  applyClickThrough()
}

function setAlwaysOnTop(on) {
  updateSettings({ alwaysOnTop: on })
  applyAlwaysOnTop()
}

function resetPosition() {
  updateSettings({ position: null })
  applyBounds()
}

function toggleVisible() {
  applyVisibility(!(win !== null && !win.isDestroyed() && win.isVisible()))
}

function quit() {
  quitting = true
  app.quit()
}

// --- IPC ----------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('bar:state', () => statePayload())
  ipcMain.handle('bar:set-pinned', (_event, pinned) => {
    setPinned(pinned === true)
    return statePayload()
  })
  ipcMain.handle('bar:set-click-through', (_event, on) => {
    setClickThrough(on === true)
    return statePayload()
  })
  ipcMain.handle('bar:refresh', async () => {
    const snapshot = await pushSnapshot(true)
    return snapshot
  })
  ipcMain.handle('bar:hide', () => {
    applyVisibility(false)
    return statePayload()
  })
  ipcMain.handle('bar:quit', () => {
    quit()
    return statePayload()
  })
  // The renderer measures the capsule and reports it, so the window always fits
  // the text — the network rates change width constantly.
  ipcMain.on('bar:size', (_event, size) => {
    const width = Math.round(Number(size?.width))
    const height = Math.round(Number(size?.height))
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    const measured = {
      width: Math.min(2400, Math.max(200, width)),
      height: Math.min(200, Math.max(20, height)),
    }
    // Docked, the bar is stretched to the work area, so the reported width is the
    // screen's rather than the content's. Only the height is meaningful there;
    // the floating width is remembered so unpinning does not produce a bar the
    // width of the monitor.
    const next = settings.pinned ? { width: barSize.width, height: measured.height } : measured
    if (next.width === barSize.width && next.height === barSize.height) return
    barSize = next
    applyBounds()
  })
}

// --- diagnostics --------------------------------------------------------------

/**
 * Capture mode also logs to a file: a packaged Windows GUI process has no
 * attached console, so stdout from `electron.exe` is not a reliable channel.
 */
const logFile = captureDir === null ? null : join(captureDir, 'log.txt')

async function log(message) {
  console.log(message)
  if (logFile === null) return
  try {
    await mkdir(captureDir, { recursive: true })
    await appendFile(logFile, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* diagnostics must never break the app */
  }
}

// --- capture diagnostic -------------------------------------------------------

/**
 * Walk the bar through its states and save what the screen actually looked like.
 *
 * A GUI app cannot be verified by unit tests alone, and this environment has no
 * human to look at it: `desktopCapturer` captures the whole display (so the
 * docking and always-on-top behaviour is visible, not just the web content),
 * and `capturePage` captures the bar itself at full resolution.
 */
async function runCapture() {
  const dir = captureDir
  await mkdir(dir, { recursive: true })
  await log(`[capture] writing to ${dir}`)

  const shoot = async (name) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1600, height: 900 },
      })
      const primary = sources[0]
      if (primary !== undefined) {
        await writeFile(join(dir, `${name}-screen.png`), primary.thumbnail.toPNG())
        await log(`[capture] ${name}-screen.png (${sources.length} source(s), ${primary.thumbnail.getSize().width}x${primary.thumbnail.getSize().height})`)
      }
    } catch (error) {
      await log(`[capture] screen grab failed: ${error.message}`)
    }
    try {
      const image = await win.webContents.capturePage()
      await writeFile(join(dir, `${name}-bar.png`), image.toPNG())
      await log(`[capture] ${name}-bar.png ${image.getSize().width}x${image.getSize().height}`)
    } catch (error) {
      await log(`[capture] window grab failed: ${error.message}`)
    }
  }

  const report = (label) => ({ label, ...statePayload(), bounds: win.getBounds(), barSize })

  /** One line after a mutation settles, so a stuck state is visible immediately. */
  const trace = async (label) => {
    await delay(120)
    await log(
      `[capture] trace ${label}: bounds=${JSON.stringify(win.getBounds())} barSize=${JSON.stringify(barSize)} ` +
        `pinned=${settings.pinned} expanded=${dockState.expanded} visible=${win.isVisible()} position=${JSON.stringify(settings.position)}`
    )
  }

  // Give the slow probes (GPU, ACPI temperature, network rate) time to land.
  await delay(6000)
  await log(`[capture] state ${JSON.stringify(report('floating'))}`)
  await shoot('01-floating')

  setPinned(true)
  dockState = { expanded: true, lastOverAt: Date.now() }
  applyBounds()
  await delay(600)
  await log(`[capture] state ${JSON.stringify(report('docked-expanded'))}`)
  await shoot('02-docked-expanded')

  // Force the hidden state: the real trigger is the cursor, which cannot be
  // moved from here.
  dockState = { expanded: false, lastOverAt: 0 }
  applyBounds()
  await delay(600)
  await log(`[capture] state ${JSON.stringify(report('docked-collapsed'))}`)
  await shoot('03-docked-collapsed')

  setClickThrough(true)
  await delay(200)
  await log(`[capture] state ${JSON.stringify(report('click-through-on'))}`)
  setClickThrough(false)

  setPinned(false)
  await trace('after setPinned(false)')
  resetPosition()
  await trace('after resetPosition()')
  await delay(400)
  await log(`[capture] state ${JSON.stringify(report('floating-again'))}`)
  await shoot('04-floating-again')

  const snapshot = await pushSnapshot(true)
  await log(
    `[capture] metrics cpu=${snapshot?.cpu?.usage} temp=${snapshot?.cpu?.temperature} gpus=${snapshot?.gpus?.length} ` +
      `down=${snapshot?.network?.downloadBytesPerSec} errors=${JSON.stringify(snapshot?.errors ?? [])}`
  )
  await log('[capture] done')

  quitting = true
  app.quit()
}

// --- lifecycle ----------------------------------------------------------------

/**
 * Boot.
 *
 * Deliberately **not** `await app.whenReady()` at the top level: in an ESM main
 * process Electron finishes loading the module *before* it emits `ready`, so
 * awaiting it at module scope deadlocks — the process stays alive with no window
 * and no error. An async function invoked without `await` avoids that entirely.
 */
async function bootstrap() {
  await log('[app] bootstrap')
  await app.whenReady()
  await log('[app] ready')
  await loadSettings()
  language = resolveLanguage(settings.language, app.getLocale())
  strings = stringsFor(language)
  await log(`[app] language=${language} settings=${JSON.stringify(settings)}`)

  registerIpc()
  createWindow()
  startMetrics()
  startDocking()

  // A global shortcut has to be treated as a nice-to-have: another app may hold
  // the combination, and there is no way to ask the user about it here. The tray
  // is the guaranteed way to turn click-through back off, so the menu is built
  // after this and shows whichever accelerator actually took.
  for (const accelerator of CLICK_THROUGH_SHORTCUTS) {
    try {
      if (globalShortcut.register(accelerator, () => setClickThrough(!settings.clickThrough))) {
        activeShortcut = accelerator
        break
      }
    } catch {
      /* try the next one */
    }
  }
  await log(`[app] click-through shortcut ${activeShortcut ?? 'unavailable (use the tray)'}`)

  trayHandle = createTray({
    assetsDir,
    strings,
    shortcut: activeShortcut ?? '—',
    settingsDir: app.getPath('userData'),
    getSettings: () => settings,
    isVisible: () => win !== null && !win.isDestroyed() && win.isVisible(),
    actions: {
      toggleVisible,
      setPinned,
      setClickThrough,
      setAlwaysOnTop,
      resetPosition,
      quit,
    },
  })
  await log('[app] tray created')

  nativeTheme.on('updated', () => broadcastState())

  if (captureDir !== null) {
    await runCapture()
  }
}

// A second launch surfaces the running bar instead of starting a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win !== null && !win.isDestroyed()) {
      applyVisibility(true)
      win.show()
    }
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('window-all-closed', () => {
    // The tray keeps the app alive; quitting is explicit.
    if (quitting) app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    clearInterval(dockTimer)
    clearInterval(pushTimer)
    stopMonitor?.()
  })

  void bootstrap().catch(async (error) => {
    await log(`[app] bootstrap failed: ${error.stack ?? error.message}`)
    quitting = true
    app.quit()
  })
}
