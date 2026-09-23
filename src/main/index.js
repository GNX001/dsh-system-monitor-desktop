import { BrowserWindow, Menu, app, desktopCapturer, globalShortcut, ipcMain, nativeTheme, screen, shell } from 'electron'
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
import { clearLoginItem, readLoginItem, readRunKey, writeLoginItem } from './login-item.js'
import { DEFAULT_SETTINGS, SETTINGS_FILE, normalizeSettings } from './settings.js'
import { readJson, writeJson } from './store.js'
import { createTray } from './tray.js'
import { hwndFromHandle, probeWindow, syntheticDrag, toPhysical } from './win-probe.js'

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
const settingsRendererFile = join(appRoot, 'src', 'settings', 'index.html')
const settingsPreloadFile = join(here, '..', 'preload', 'settings.cjs')

/** Fallback content size, replaced by whatever the renderer measures. Wide
 *  enough that the first layout has room to report its true width from. */
const FALLBACK_SIZE = { width: 900, height: 34 }
/** How often the dock state is re-evaluated. Cheap: one cursor read. */
const DOCK_POLL_MS = 100
/** How often a fresh snapshot is pushed to the renderer. */
const METRICS_PUSH_MS = 1000
/** Escape hatch for click-through, which otherwise leaves the bar unclickable. */
const CLICK_THROUGH_SHORTCUTS = ['CommandOrControl+Alt+L', 'CommandOrControl+Alt+B', 'CommandOrControl+Alt+Y']
/**
 * How long after the last movement event the bar is considered released.
 *
 * A window drag runs inside a modal OS loop that Electron does not surface; all
 * we see is movement, and the loop is over when the movement stops.
 */
const DRAG_SETTLE_MS = 350

/** Folders the app may write to, resolved lazily once `app` is ready. */
const settingsFile = () => join(app.getPath('userData'), SETTINGS_FILE)

let win = null
let settingsWin = null
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
/**
 * True while the pointer is dragging the bar.
 *
 * During a drag Windows runs a modal move loop and owns the window's position.
 * Writing bounds from here — which happens every time the readings change the
 * bar's width — fights that loop and is what made dragging stutter, so while this
 * is set the writes are counted and deferred instead, and applied in one step
 * once the drag settles.
 */
let dragging = false
let dragTimer = null
/**
 * Set by the diagnostics, which drive the dock state themselves.
 *
 * The live loop reacts to the real cursor, so a forced state would be undone
 * within a poll or two — and a screenshot taken a second later would show the
 * state the *cursor* wanted, not the one the diagnostic asked for.
 */
let dockFrozen = false
/** Counters behind `--drag`; untouched unless a diagnostic asked for them. */
const counters = { move: 0, moved: 0, writes: 0, duringDrag: 0 }
let strings = stringsFor('en')
let language = 'en'
let activeShortcut = null
/** Where the sign-in entry currently points, or null; read back from the registry. */
let loginItemPath = null

/** Capture mode: `--capture[=dir]` walks the states and saves PNGs, then exits. */
const captureArg = process.argv.find((arg) => arg === '--capture' || arg.startsWith('--capture='))
const captureDir = captureArg === undefined ? null : captureArg.includes('=') ? captureArg.split('=')[1] : join(appRoot, 'capture')

/** Probe mode: `--probe[=dir]` asks Windows whether click-through really works. */
const probeArg = process.argv.find((arg) => arg === '--probe' || arg.startsWith('--probe='))
const probeDir = probeArg === undefined ? null : probeArg.includes('=') ? probeArg.split('=')[1] : join(appRoot, 'probe')

/** Drag mode: `--drag[=dir]` drags the bar with real input and times the result. */
const dragArg = process.argv.find((arg) => arg === '--drag' || arg.startsWith('--drag='))
const dragDir = dragArg === undefined ? null : dragArg.includes('=') ? dragArg.split('=')[1] : join(appRoot, 'drag')

/** Login mode: `--login-test[=dir]` round-trips the sign-in entry and restores it. */
const loginArg = process.argv.find((arg) => arg === '--login-test' || arg.startsWith('--login-test='))
const loginDir = loginArg === undefined ? null : loginArg.includes('=') ? loginArg.split('=')[1] : join(appRoot, 'login-test')

/** Any diagnostic writes here; a normal run writes nothing. */
const diagnosticDir = captureDir ?? probeDir ?? dragDir ?? loginDir

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
  const before = settings
  settings = normalizeSettings({ ...settings, ...patch })
  persistSettings()

  // A few settings change something outside the window, so they are applied here
  // rather than by the control that asked for them.
  if (settings.language !== before.language) {
    language = resolveLanguage(settings.language, app.getLocale())
    strings = stringsFor(language)
    settingsWin?.setTitle(strings.settingsTitle)
  }
  if (settings.theme !== before.theme) applyTheme()
  if (settings.openAtLogin !== before.openAtLogin) void applyLoginItem()

  trayHandle?.refresh()
  broadcastState()
  broadcastSettings()
}

/** The theme setting drives Electron's own theme source, so the OS-level frame
 *  (and `shouldUseDarkColors`, which the renderers follow) matches it. */
function applyTheme() {
  nativeTheme.themeSource = settings.theme === 'auto' ? 'system' : settings.theme
}

/** `"C:\dir with spaces\app.exe"` → `C:\dir with spaces\app.exe`. */
function unquoteRunValue(value) {
  const match = /^"(.*)"$/.exec(value)
  return match === null ? value : match[1]
}

/**
 * Read where the sign-in entry actually points.
 *
 * Deliberately not done at startup: it costs a process spawn, and the answer is
 * only interesting to the settings window — a portable build that has been moved
 * keeps a stale path, which no switch position can reveal.
 */
async function refreshLoginItemPath() {
  if (!app.isPackaged) return
  const registered = await readLoginItem(app.getName())
  loginItemPath = typeof registered.value === 'string' ? unquoteRunValue(registered.value) : null
}

/**
 * Register or remove the sign-in entry.
 *
 * Only meaningful for the packaged app: in a development run `process.execPath`
 * is Electron's own binary, so registering it would put a stray `electron.exe`
 * entry in the user's Run key pointing at a source tree.
 *
 * The entry itself is written by `login-item.js` — quoted, and with the registry
 * read back through the same code — rather than by `app.setLoginItemSettings`,
 * which writes the path unquoted. See that module for the evidence.
 */
async function applyLoginItem(enabled = settings.openAtLogin) {
  if (!app.isPackaged) {
    await log(`[login] sign-in entry ${enabled ? 'requested' : 'cleared'} but skipped: not a packaged build`)
    return
  }

  const name = app.getName()
  if (enabled) {
    const written = await writeLoginItem(name, process.execPath)
    if (written.error !== undefined) {
      await log(`[login] could not register the sign-in entry: ${written.error}`)
      return
    }
    loginItemPath = process.execPath
    await log(`[login] registered "${name}" -> "${process.execPath}"`)
    return
  }

  const cleared = await clearLoginItem(name)
  loginItemPath = null
  await log(cleared.error === undefined ? `[login] removed the "${name}" entry` : `[login] could not remove the entry: ${cleared.error}`)
}

// --- window -------------------------------------------------------------------

function workAreaFor(bounds) {
  return resolveWorkArea(screen.getAllDisplays(), bounds, screen.getPrimaryDisplay())
}

/**
 * Single place that decides where the window goes: docked (at the top edge, its
 * own size, centred) or floating (its own size, at its remembered position).
 *
 * The one rule here that is easy to miss: never write bounds while the user is
 * dragging. See {@link dragging}.
 */
function applyBounds(reason = 'apply') {
  if (win === null || win.isDestroyed()) return
  if (dragging) {
    counters.duringDrag++
    return
  }
  counters.writes++
  const workArea = workAreaFor(win.getBounds())
  programmaticMoveUntil = Date.now() + 300
  if (settings.pinned) {
    win.setBounds(dockedBounds(workArea, barSize, dockState.expanded))
    return
  }
  const size = { width: barSize.width, height: barSize.height }
  const wanted = settings.position ?? defaultFloatingPosition(size, workArea)
  win.setBounds({ ...clampFloatingPosition(wanted, size, workArea), ...size })
}

/**
 * Note movement that was not ours, and treat it as a drag in progress.
 *
 * Both `move` and `moved` are observed: which of them Windows reports while the
 * mouse button is held is an Electron detail, and either one proves the user has
 * the window.
 */
function noteMovement(event) {
  counters[event] += 1
  if (Date.now() < programmaticMoveUntil) return
  dragging = true
  clearTimeout(dragTimer)
  dragTimer = setTimeout(endDrag, DRAG_SETTLE_MS)
}

/** The drag is over: keep where the user put the bar, then apply what was deferred. */
function endDrag() {
  dragging = false
  if (win === null || win.isDestroyed() || settings.pinned) return
  const bounds = win.getBounds()
  const size = { width: bounds.width, height: bounds.height }
  const workArea = workAreaFor(bounds)
  // Persist the *clamped* position: the drag may have ended partly off the work
  // area, and applying bounds from the previous position would teleport the bar
  // back to where the drag started.
  settings.position = clampFloatingPosition({ x: bounds.x, y: bounds.y }, size, workArea)
  persistSettings()
  // Re-applies the measurements that came in mid-drag, in one step.
  applyBounds('settle after drag')
}

function applyAlwaysOnTop() {
  if (win === null || win.isDestroyed()) return
  // 'screen-saver' keeps the bar above ordinary windows and above most
  // full-screen apps, which is what "always on top" means for a widget.
  win.setAlwaysOnTop(settings.alwaysOnTop, settings.alwaysOnTop ? 'screen-saver' : 'normal')
}

function applyClickThrough() {
  if (win === null || win.isDestroyed()) return
  // No `forward`: forwarding mouse *move* messages is what makes the bar light
  // its buttons up under a pointer that cannot press them, which reads as
  // click-through being broken. With it off the bar goes inert as well as deaf.
  win.setIgnoreMouseEvents(settings.clickThrough)
}

function applyVisibility(visible) {
  if (win === null || win.isDestroyed()) return
  if (visible) {
    win.showInactive()
    // `skipTaskbar` is a request to the shell, not a window style, and showing a
    // window can bring the tab back — so it is re-asserted whenever the bar is
    // shown rather than only where it is created.
    win.setSkipTaskbar(true)
    applyBounds('shown')
  } else {
    win.hide()
  }
  trayHandle?.refresh()
  broadcastSettings()
}

function statePayload() {
  return {
    pinned: settings.pinned,
    expanded: dockState.expanded,
    clickThrough: settings.clickThrough,
    alwaysOnTop: settings.alwaysOnTop,
    theme: settings.theme,
    opacity: settings.opacity,
    dark: nativeTheme.shouldUseDarkColors,
    language,
    visible: win !== null && !win.isDestroyed() ? win.isVisible() : false,
  }
}

function broadcastState() {
  if (win === null || win.isDestroyed()) return
  win.webContents.send('bar:state', statePayload())
}

/**
 * What the settings window draws: the stored settings plus everything derived
 * from them, so no control has to work out what a value means.
 */
function settingsPayload() {
  return {
    ...settings,
    resolvedLanguage: language,
    dark: nativeTheme.shouldUseDarkColors,
    shortcut: activeShortcut ?? '',
    visible: win !== null && !win.isDestroyed() && win.isVisible(),
    packaged: app.isPackaged,
    execPath: process.execPath,
    loginItemPath,
  }
}

function broadcastSettings() {
  if (settingsWin === null || settingsWin.isDestroyed()) return
  settingsWin.webContents.send('settings:changed', settingsPayload())
}

/**
 * Show the settings window, or bring it back if it is already open.
 *
 * It is hidden from the taskbar along with the bar — this app lives in the tray —
 * so the tray's "Settings…" and the ⚙ button on the bar are the two ways to it,
 * and both of them surface the same window.
 */
function openSettingsWindow() {
  // Where the sign-in entry points is read on demand and pushed to the window,
  // since a stale path is the one thing its own switch cannot show.
  const refreshLater = () => void refreshLoginItemPath().then(() => broadcastSettings())

  if (settingsWin !== null && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    broadcastSettings()
    refreshLater()
    return
  }

  settingsWin = new BrowserWindow({
    width: 470,
    height: 700,
    minWidth: 420,
    minHeight: 460,
    useContentSize: true,
    title: strings.settingsTitle,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1d21' : '#f6f7fa',
    skipTaskbar: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: settingsPreloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  settingsWin.once('ready-to-show', () => {
    settingsWin.show()
    settingsWin.focus()
  })
  settingsWin.on('closed', () => {
    settingsWin = null
  })
  settingsWin.webContents.on('did-finish-load', () => {
    broadcastSettings()
    refreshLater()
  })
  void settingsWin.loadFile(settingsRendererFile)
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
    // The bar belongs to the tray, not the taskbar: a permanent taskbar button
    // for an always-on-top widget is clutter, and the tray icon is the control
    // centre anyway.
    skipTaskbar: true,
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

  // Movement, in both the shapes Electron reports it, feeds the drag detector:
  // a drag ends the position for a floating bar and does nothing for a docked one.
  win.on('move', () => noteMovement('move'))
  win.on('moved', () => noteMovement('moved'))

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
    if (dockFrozen || win === null || win.isDestroyed() || !settings.pinned || dragging) return
    const bounds = win.getBounds()
    const workArea = workAreaFor(bounds)
    const cursor = screen.getCursorScreenPoint()
    const next = reduceDockState(dockState, {
      cursor,
      workArea,
      bar: barSize,
      now: Date.now(),
      pinned: true,
    })
    if (next === dockState) return
    const expandedChanged = next.expanded !== dockState.expanded
    dockState = next
    if (expandedChanged) {
      applyBounds('dock state changed')
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
    // Wherever it was docked becomes where it floats — but only after clamping.
    // Unpinning from the hidden state would otherwise remember a *negative* y,
    // because a collapsed docked bar sits above the work area, and no floating
    // position can be above the work area.
    const bounds = win === null || win.isDestroyed() ? null : win.getBounds()
    const position =
      bounds === null
        ? settings.position
        : clampFloatingPosition(
            { x: bounds.x, y: bounds.y },
            { width: bounds.width, height: bounds.height },
            workAreaFor(bounds),
          )
    updateSettings({ pinned, position })
    applyBounds('unpinned')
    broadcastState()
    return
  }
  updateSettings({ pinned })
  applyBounds('pinned')
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

  // --- the settings window ---------------------------------------------------

  ipcMain.handle('settings:open', () => {
    openSettingsWindow()
    return true
  })

  ipcMain.handle('settings:get', () => settingsPayload())

  // A patch is only ever the persisted keys: the renderer cannot thread a new
  // key into the settings file, and `normalizeSettings` still has the last word
  // on every value.
  ipcMain.handle('settings:set', (_event, patch) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return settingsPayload()
    const accepted = {}
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (Object.hasOwn(patch, key)) accepted[key] = patch[key]
    }
    if (Object.keys(accepted).length > 0) updateSettings(accepted)
    return settingsPayload()
  })

  ipcMain.handle('settings:action', (_event, name) => {
    switch (name) {
      case 'reset-position':
        resetPosition()
        break
      case 'show-bar':
        applyVisibility(true)
        break
      case 'hide-bar':
        applyVisibility(false)
        break
      case 'open-folder':
        void shell.openPath(app.getPath('userData'))
        break
      case 'quit':
        quit()
        break
      default:
        break
    }
    return settingsPayload()
  })

  // The renderer measures the capsule and reports it, so the window always fits
  // the text — the network rates change width constantly. The bar keeps that
  // width docked too, so there is only one size to track.
  ipcMain.on('bar:size', (_event, size) => {
    const width = Math.round(Number(size?.width))
    const height = Math.round(Number(size?.height))
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    const measured = {
      width: Math.min(2400, Math.max(200, width)),
      height: Math.min(200, Math.max(20, height)),
    }
    if (measured.width === barSize.width && measured.height === barSize.height) return
    barSize = measured
    applyBounds('renderer measured the capsule')
  })
}

// --- diagnostics --------------------------------------------------------------

/**
 * Capture mode also logs to a file: a packaged Windows GUI process has no
 * attached console, so stdout from `electron.exe` is not a reliable channel.
 */
const logFile = diagnosticDir === null ? null : join(diagnosticDir, 'log.txt')

async function log(message) {
  console.log(message)
  if (logFile === null) return
  try {
    await mkdir(diagnosticDir, { recursive: true })
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
  // This diagnostic drives the dock state itself; the live loop would undo it
  // between forcing a state and taking the picture.
  dockFrozen = true
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

        // A band around the bar itself, which is what the README needs: the whole
        // desktop shot proves where the bar is, but it is too small to read.
        const bounds = win.getBounds()
        const display = screen.getDisplayMatching(bounds)
        // `display.size` is in DIP while the thumbnail is in physical pixels, so
        // the scale needs the factor or the crop lands in the wrong place.
        const scale = primary.thumbnail.getSize().width / (display.size.width * display.scaleFactor)
        const pad = 40
        const crop = {
          x: Math.max(0, Math.round((bounds.x * display.scaleFactor - pad) * scale)),
          y: 0,
          width: Math.round((bounds.width * display.scaleFactor + pad * 2) * scale),
          height: Math.round((bounds.y * display.scaleFactor + bounds.height * display.scaleFactor + 40) * scale),
        }
        crop.width = Math.max(16, Math.min(crop.width, primary.thumbnail.getSize().width - crop.x))
        crop.height = Math.max(16, Math.min(crop.height, primary.thumbnail.getSize().height - crop.y))
        const band = primary.thumbnail.crop(crop)
        await writeFile(join(dir, `${name}-band.png`), band.toPNG())
        await log(`[capture] ${name}-band.png ${band.getSize().width}x${band.getSize().height} (crop ${JSON.stringify(crop)})`)
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

  // Appearance. The theme and the opacity slider are the two settings whose
  // effect is purely visual, so they are captured rather than asserted.
  updateSettings({ theme: 'light', opacity: 0.35 })
  await delay(600)
  await log(`[capture] state ${JSON.stringify(report('light-transparent'))}`)
  await shoot('05-light-transparent')

  updateSettings({ theme: 'dark', opacity: 1 })
  await delay(600)
  await log(`[capture] state ${JSON.stringify(report('dark-opaque'))}`)
  await shoot('06-dark-opaque')

  updateSettings({ theme: 'auto', opacity: 0.94 })
  await delay(300)

  // The settings window: opened the way the tray does, so this also proves the
  // window builds, loads its preload and receives state.
  openSettingsWindow()
  await delay(3000)
  if (settingsWin !== null && !settingsWin.isDestroyed()) {
    try {
      const image = await settingsWin.webContents.capturePage()
      await writeFile(join(dir, '07-settings-window.png'), image.toPNG())
      await log(`[capture] 07-settings-window.png ${image.getSize().width}x${image.getSize().height}`)
    } catch (error) {
      await log(`[capture] settings grab failed: ${error.message}`)
    }
    const painted = await settingsWin.webContents
      .executeJavaScript('document.querySelectorAll(".row").length + "/" + document.querySelectorAll(".section").length')
      .catch((error) => `error: ${error.message}`)
    await log(`[capture] settings window built ${painted} (rows/sections)`)
    settingsWin.close()
  } else {
    await log('[capture] settings window did not open')
  }
  await delay(500)

  const snapshot = await pushSnapshot(true)
  await log(
    `[capture] metrics cpu=${snapshot?.cpu?.usage} temp=${snapshot?.cpu?.temperature} gpus=${snapshot?.gpus?.length} ` +
      `down=${snapshot?.network?.downloadBytesPerSec} errors=${JSON.stringify(snapshot?.errors ?? [])}`
  )
  await log('[capture] done')

  quitting = true
  app.quit()
}

// --- click-through probe ------------------------------------------------------

/**
 * Ask Windows whether click-through really works — and whether it *stays* set.
 *
 * `setIgnoreMouseEvents` always returns normally, so its effect has to be read
 * back from the OS: the window's `WS_EX_TRANSPARENT` bit, and `WindowFromPoint`
 * at the bar's own coordinates (the OS's own answer to "which window is here?").
 *
 * Setting the bit once proves nothing about real use, so each step then runs the
 * movements a normal session performs — resizing as the readings change width,
 * re-asserting always-on-top, hiding and showing, docking — and re-reads the bit.
 * Those calls go through SetWindowPos and could plausibly drop it.
 *
 * A real synthetic click corroborates the hit-test, but only where it cannot land
 * on a stranger's window: on our own refresh button (the click-through-off
 * control, which also proves the click counter works) or on the desktop.
 */
async function runProbe() {
  const dir = probeDir
  // The probe moves the window deliberately (dock cycles included), so the live
  // loop must not be repositioning it underneath.
  dockFrozen = true
  await mkdir(dir, { recursive: true })
  await log(`[probe] writing to ${dir}`)

  const handle = win.getNativeWindowHandle()
  const hwnd = hwndFromHandle(handle)
  await log(`[probe] native handle is ${handle.length} bytes -> hwnd ${hwnd} (0x${hwnd.toString(16)})`)

  // Electron speaks DIP; the probe speaks physical pixels. Without this
  // conversion the injected input lands somewhere else entirely and the probe
  // dutifully reports whichever window it hit instead.
  const display = screen.getDisplayMatching(win.getBounds())
  const toDevice = (point) => toPhysical(point, display)
  await log(
    `[probe] display ${display.size.width}x${display.size.height} at (${display.bounds.x},${display.bounds.y}) ` +
      `scaleFactor=${display.scaleFactor}; bar in DIP ${JSON.stringify(win.getBounds())}`,
  )

  const clicksOn = (id) =>
    win.webContents
      .executeJavaScript(
        `(() => { const el = document.getElementById(${JSON.stringify(id)});` +
          ` if (!el) return null; const r = el.getBoundingClientRect();` +
          ` return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
      )
      .catch(() => null)
  const counter = () => win.webContents.executeJavaScript('window.__dsmClicks || 0').catch(() => -1)

  /** Screen coordinates of a renderer element, which is where a real click has to go. */
  const screenPointOf = async (id) => {
    const local = await clicksOn(id)
    if (local === null) return null
    const bounds = win.getBounds()
    return { x: bounds.x + local.x, y: bounds.y + local.y }
  }

  const centerPoint = () => {
    const bounds = win.getBounds()
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
  }

  /**
   * Steps: set click-through, then perturb the window the way a session does,
   * and read the OS back after each. The control step must show the bit off and
   * the point landing on the bar, or the whole probe is meaningless.
   */
  const steps = [
    { label: 'off-control', apply: () => win.setIgnoreMouseEvents(false) },
    { label: 'on-forward-true', apply: () => win.setIgnoreMouseEvents(true, { forward: true }) },
    { label: 'on-forward-false', apply: () => win.setIgnoreMouseEvents(true, { forward: false }) },
    { label: 'on-no-options', apply: () => win.setIgnoreMouseEvents(true) },
    {
      label: 'on-then-resize',
      apply: () => win.setIgnoreMouseEvents(true, { forward: true }),
      perturb: () => {
        const bounds = win.getBounds()
        win.setBounds({ ...bounds, width: bounds.width + 40 })
        win.setBounds(bounds)
      },
    },
    {
      label: 'on-then-always-on-top',
      apply: () => win.setIgnoreMouseEvents(true, { forward: true }),
      perturb: () => {
        win.setAlwaysOnTop(true, 'screen-saver')
        win.setAlwaysOnTop(settings.alwaysOnTop, settings.alwaysOnTop ? 'screen-saver' : 'normal')
      },
    },
    {
      label: 'on-then-hide-show',
      apply: () => win.setIgnoreMouseEvents(true, { forward: true }),
      perturb: () => {
        win.hide()
        win.showInactive()
      },
    },
    {
      label: 'on-then-dock-cycle',
      apply: () => win.setIgnoreMouseEvents(true, { forward: true }),
      perturb: () => {
        win.setBounds(dockedBounds(workAreaFor(win.getBounds()), barSize.height, true))
        win.setBounds(dockedBounds(workAreaFor(win.getBounds()), barSize.height, false))
        applyBounds()
      },
    },
  ]

  let effective = null
  for (const step of steps) {
    step.apply()
    await delay(250)
    if (step.perturb !== undefined) {
      step.perturb()
      await delay(250)
    }

    const point = toDevice(centerPoint())
    const hit = await probeWindow({ hwnd, x: point.x, y: point.y })
    const under = String(hit.windowFromPoint ?? '')
    const hitsBar = hit.pointHitsBar === true
    const overDesktop = /Progman|WorkerW|SHELLDLL_DefView/.test(under)

    // Press the refresh button, which is a no-drag region: a press on the drag
    // handle starts a window-move loop and never reaches the renderer, so the
    // bar's centre cannot be used to prove delivery.
    const dipButton = await screenPointOf('refresh')
    const button = dipButton === null ? null : toDevice(dipButton)
    const before = await counter()
    let clickReport = 'skipped (no probe target)'
    const target = button ?? (hitsBar || overDesktop ? point : null)
    if (target !== null) {
      const clicked = await probeWindow({ hwnd, x: target.x, y: target.y, click: true })
      const after = await counter()
      clickReport = `real click at (${target.x},${target.y}) -> renderer saw ${after - before}; foreground after: ${clicked.foregroundAfterClick}`
    }

    await log(`[probe] ${step.label}`)
    await log(`[probe]   exStyle=${hit.exStyle} bits=${JSON.stringify(hit.bits)}`)
    await log(`[probe]   probing physical (${point.x},${point.y}); Windows says the bar is at ${hit.barRect} on a ${hit.screen} screen`)
    await log(`[probe]   windowFromPoint=${under}  pointHitsBar=${hitsBar}`)
    await log(`[probe]   ${clickReport}`)

    // Verdict only for the plain on/off steps: the perturbed ones are about the
    // bit surviving, which the exStyle line above already answers.
    if (step.label === 'off-control') effective = hitsBar === true
    if (step.perturb === undefined && step.label.startsWith('on-')) {
      const verdict = hitsBar === false && hit.bits?.transparent === true
      await log(`[probe]   -> click-through ${verdict ? 'EFFECTIVE' : 'NOT effective'}`)
    } else if (step.perturb !== undefined) {
      const kept = hit.bits?.transparent === true && hitsBar === false
      await log(`[probe]   -> bit survived the perturbation: ${kept}`)
    }

    try {
      const image = await win.webContents.capturePage()
      await writeFile(join(dir, `bar-${step.label}.png`), image.toPNG())
    } catch (error) {
      await log(`[probe]   bar grab failed: ${error.message}`)
    }
  }

  await log(`[probe] control (click-through off) blocks clicks: ${effective}`)
  applyClickThrough()
  await log('[probe] done')
  quitting = true
  app.quit()
}

// --- drag diagnostic ----------------------------------------------------------

/**
 * Drag the bar with real injected mouse input and report what it cost.
 *
 * "Dragging feels rough" is a timing complaint, so it needs numbers rather than a
 * look: how many movement events arrive (which is what the drag detector has to
 * work from), how many bounds writes were issued while the drag was in progress
 * (the stutter), and how many were deferred to the end of it (the fix).
 */
async function runDragTest() {
  const dir = dragDir
  await mkdir(dir, { recursive: true })
  await log('[drag] letting the first readings land')
  await delay(3000)

  const before = win.getBounds()
  const display = screen.getDisplayMatching(before)
  const dipFrom = { x: Math.round(before.x + before.width / 2), y: Math.round(before.y + before.height / 2) }
  const dipTo = { x: dipFrom.x - 320, y: dipFrom.y + 140 }
  const from = toPhysical(dipFrom, display)
  const to = toPhysical(dipTo, display)
  await log(
    `[drag] scaleFactor=${display.scaleFactor}; bar in DIP ${JSON.stringify(before)}; ` +
      `dragging physical (${from.x},${from.y}) -> (${to.x},${to.y})`,
  )

  counters.move = 0
  counters.moved = 0
  counters.writes = 0
  counters.duringDrag = 0

  // While the drag runs, ask for bounds writes the way the readings do (the
  // capsule's width changes with the numbers), and record how far the bar would
  // have been yanked had those writes been applied: `applyBounds` positions the
  // window from the *remembered* position, which mid-drag is wherever the drag
  // started, so every write teleports the bar out from under the pointer.
  let worstYank = 0
  const churn = setInterval(() => {
    if (!dragging) return
    const live = win.getBounds()
    const saved = settings.position ?? { x: live.x, y: live.y }
    worstYank = Math.max(worstYank, Math.abs(live.x - saved.x) + Math.abs(live.y - saved.y))
    applyBounds('simulated reading change')
  }, 200)

  const started = Date.now()
  const result = await syntheticDrag({ from, to, steps: 45, stepMs: 12 })
  const elapsed = Date.now() - started
  clearInterval(churn)
  // The settle timer has to expire after the last movement for the drag to end.
  await delay(DRAG_SETTLE_MS + 400)

  const after = win.getBounds()
  const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y)
  await log(`[drag] ${result.ok === true ? 'injected OK' : `injection failed: ${result.error ?? result.stderr}`} in ${elapsed} ms`)
  await log(`[drag] injection finished with the cursor at ${result.cursorAfter} on a ${result.screen} screen`)
  await log(`[drag] movement events: move=${counters.move} moved=${counters.moved}`)
  await log(`[drag] bounds writes during the drag: ${counters.duringDrag} suppressed, ${counters.writes} applied`)
  await log(`[drag] a write mid-drag would have yanked the bar up to ${worstYank} px away from the pointer`)
  await log(`[drag] bar moved ${moved} px: ${JSON.stringify(after)}`)
  await log(`[drag] saved position: ${JSON.stringify(settings.position)}`)
  await log(`[drag] floating=${!settings.pinned} dragging-flag-cleared=${!dragging}`)

  try {
    const image = await win.webContents.capturePage()
    await writeFile(join(dir, 'after-drag.png'), image.toPNG())
  } catch (error) {
    await log(`[drag] grab failed: ${error.message}`)
  }

  await log('[drag] done')
  quitting = true
  app.quit()
}

// --- sign-in entry diagnostic -------------------------------------------------

/**
 * Round-trip the sign-in entry and put it back.
 *
 * `app.setLoginItemSettings` reports nothing, and on Windows it writes to the
 * user's Run key — so the only honest check is to enable it, read the registry
 * back through Electron, and restore whatever was there before.
 */
/**
 * Round-trip the sign-in entry and put it back.
 *
 * `setLoginItemSettings` reports nothing, and on Windows the entry is a registry
 * value — so the only honest check is to write it, read the exact value back (a
 * path with spaces must come back quoted), and restore whatever was there before.
 */
async function runLoginTest() {
  await mkdir(loginDir, { recursive: true })
  const name = app.getName()
  const registry = async (label) => {
    const result = await readRunKey()
    const value = result.entries?.[name]
    await log(`[login] registry ${label}: ${value === undefined ? '(no entry)' : value}`)
    return value
  }

  await log(`[login] packaged=${app.isPackaged} execPath=${process.execPath} name=${name}`)
  await log(`[login] path contains a space: ${process.execPath.includes(' ')}`)

  const original = await registry('before')
  await log(`[login] electron getLoginItemSettings(): ${JSON.stringify(app.getLoginItemSettings({ path: process.execPath, args: [] }))}`)

  await applyLoginItem(true)
  await delay(200)
  const written = await registry('after enabling')

  await applyLoginItem(original !== undefined)
  await delay(200)
  const restored = await registry('after restoring')

  const quoted = typeof written === 'string' && written.startsWith('"') && written.endsWith('"')
  const roundTripped = written === `"${process.execPath}"` && (restored ?? undefined) === original
  await log(`[login] written value is quoted: ${quoted}`)
  await log(`[login] round trip: ${roundTripped ? 'OK' : 'FAILED'}`)
  await log('[login] done')

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

  // Applied before any window exists so the first paint already has the right
  // palette and the sign-in entry matches the stored intent.
  applyTheme()
  await applyLoginItem()

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
    settingsDir: app.getPath('userData'),
    getSettings: () => settings,
    getStrings: () => strings,
    getShortcut: () => activeShortcut ?? strings.shortcutUnavailable,
    isVisible: () => win !== null && !win.isDestroyed() && win.isVisible(),
    actions: {
      toggleVisible,
      setPinned,
      setClickThrough,
      setAlwaysOnTop,
      resetPosition,
      openSettings: openSettingsWindow,
      quit,
    },
  })
  await log('[app] tray created')

  // Both renderers follow the resolved dark/light state, so a change in the OS
  // has to reach them (theme 'auto' means exactly this).
  nativeTheme.on('updated', () => {
    broadcastState()
    broadcastSettings()
  })

  if (loginDir !== null) {
    await runLoginTest()
    return
  }
  if (captureDir !== null) {
    await runCapture()
  }
  if (probeDir !== null) {
    await runProbe()
  }
  if (dragDir !== null) {
    await runDragTest()
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
