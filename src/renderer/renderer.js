import { DEFAULT_OPTIONS, buildViewModel } from '../shared/model.js'
import { bindDictionary, en, zh } from '../shared/locales.js'
import { resolveLanguage, stringsFor } from '../shared/strings.js'

/** Divider between two metric items — the same glyph the DSH plugin uses. */
const ITEM_SEPARATOR = '丨'

/**
 * The capsule renderer.
 *
 * Metric text comes from the same `buildViewModel` the DSH plugin uses, so both
 * products format a byte pair, a rate and a severity identically; only the
 * palette and the button set differ.
 *
 * The bar has no title bar and no footer: a grip, the items, a status dot when
 * something is wrong, then ⟳ 📌 ✕, with the pin immediately before the close
 * button.
 */

const api = window.barApi
const bar = document.getElementById('bar')
const items = document.getElementById('items')
const statusDot = document.getElementById('status')
const settingsButton = document.getElementById('settings')
const refreshButton = document.getElementById('refresh')
const pinButton = document.getElementById('pin')
const closeButton = document.getElementById('close')

const DICTIONARIES = { zh, en }

let language = resolveLanguage('auto', navigator.language)
let t = bindDictionary(DICTIONARIES[language])
let ui = stringsFor(language)
let state = { pinned: false, expanded: true, clickThrough: false, alwaysOnTop: true, dark: null, theme: 'auto', opacity: 0.94 }
let latest = null
let refreshing = false

/** Apply everything that depends on the resolved language. */
function applyLanguage() {
  t = bindDictionary(DICTIONARIES[language])
  ui = stringsFor(language)
  refreshButton.title = t('refresh')
  refreshButton.setAttribute('aria-label', t('refresh'))
  settingsButton.title = ui.settingsLabel
  settingsButton.setAttribute('aria-label', ui.settingsLabel)
  closeButton.title = ui.hide
  closeButton.setAttribute('aria-label', ui.hide)
  pinButton.title = state.pinned ? ui.pinOn : ui.pinOff
  pinButton.setAttribute('aria-label', ui.pinLabel)
  bar.title = state.clickThrough ? ui.clickThroughOn : state.pinned ? ui.dockedHint : ''
  render()
}

/** Build one metric item: label, headline value, then trailing details. */
function buildItem(row) {
  const element = document.createElement('span')
  element.className = 'dsm-item'
  element.dataset.key = row.key
  if (typeof row.title === 'string' && row.title !== '') element.title = row.title

  const label = document.createElement('span')
  label.className = 'dsm-label'
  label.textContent = t(row.labelKey, row.labelParams)
  element.append(label)

  const value = document.createElement('span')
  value.className = row.valueText === null ? 'dsm-value dsm-unknown' : `dsm-value dsm-${row.severity}`
  value.textContent = row.valueText ?? '—'
  element.append(value)

  for (const detail of row.details) {
    const chip = document.createElement('span')
    chip.className = detail.tone === 'muted' || detail.tone === 'ok' ? 'dsm-detail' : `dsm-detail dsm-${detail.tone}`
    chip.textContent = detail.text
    element.append(chip)
  }
  return element
}

/** Re-render the items from the last snapshot (or a placeholder before the first). */
function render() {
  const view = buildViewModel(latest, DEFAULT_OPTIONS)
  items.replaceChildren()

  if (view.rows.length === 0) {
    const note = document.createElement('span')
    note.className = 'dsm-note'
    note.textContent = t('loading')
    items.append(note)
  } else {
    view.rows.forEach((row, index) => {
      if (index > 0) {
        const separator = document.createElement('span')
        separator.className = 'dsm-sep'
        separator.setAttribute('aria-hidden', 'true')
        separator.textContent = ITEM_SEPARATOR
        items.append(separator)
      }
      items.append(buildItem(row))
    })
  }

  const broken = view.ok !== true || view.errors.length > 0
  statusDot.hidden = !broken
  statusDot.dataset.status = view.ok === true ? 'error' : 'loading'
  statusDot.title = view.errors.map((entry) => `${entry.source}: ${entry.message}`).join('\n')
}

function setState(next) {
  if (next === null || next === undefined) return
  const languageChanged = next.language !== undefined && next.language !== language
  state = { ...state, ...next }
  if (languageChanged) {
    language = next.language
    applyLanguage()
  }
  // `dark` is already resolved by the main process: for theme 'auto' it follows
  // the OS, otherwise it is what the user picked.
  document.documentElement.dataset.theme = state.dark === false ? 'light' : 'dark'
  // Only the tint fades; the palette above stays fully opaque.
  const opacity = typeof state.opacity === 'number' ? state.opacity : 0.94
  document.documentElement.style.setProperty('--bg-alpha', String(opacity))
  // Click-through makes the buttons unreachable, so the styling has to say so
  // rather than light up under a pointer that cannot press anything.
  document.body.dataset.clickThrough = state.clickThrough ? '1' : '0'
  bar.dataset.pinned = state.pinned ? '1' : '0'
  bar.title = state.clickThrough ? ui.clickThroughOn : state.pinned ? ui.dockedHint : ''
  pinButton.setAttribute('aria-pressed', state.pinned ? 'true' : 'false')
  pinButton.title = state.pinned ? ui.pinOn : ui.pinOff
}

// --- wiring -------------------------------------------------------------------

refreshButton.addEventListener('click', async () => {
  if (refreshing) return
  refreshing = true
  refreshButton.dataset.spin = '1'
  try {
    const snapshot = await api.refresh()
    if (snapshot !== null && typeof snapshot === 'object') {
      latest = snapshot
      render()
    }
  } finally {
    refreshing = false
    refreshButton.dataset.spin = '0'
  }
})

settingsButton.addEventListener('click', () => {
  void api.openSettings()
})

pinButton.addEventListener('click', async () => {
  setState(await api.setPinned(!state.pinned))
})

closeButton.addEventListener('click', () => {
  void api.hide()
})

api.onSnapshot((snapshot) => {
  latest = snapshot
  render()
})

api.onState(setState)

// Report the capsule's measured size so the window always fits the text: the
// network rates change width from one poll to the next.
//
// The BORDER box is what has to be measured, not `contentRect`: the window is
// sized to include the capsule's padding and border, so reporting the content
// box made every window a few pixels small and clipped the last item. The bar
// also carries `width: max-content` while floating, which makes this value
// independent of the window — otherwise measuring a stretched bar and resizing
// the window to match would feed back on itself.
const observer = new ResizeObserver((entries) => {
  const entry = entries[0]
  if (entry === undefined) return
  const box = entry.borderBoxSize?.[0]
  const rect = entry.target.getBoundingClientRect()
  const width = Math.ceil(box === undefined ? rect.width : box.inlineSize)
  const height = Math.ceil(box === undefined ? rect.height : box.blockSize)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return
  api.reportSize({ width, height })
})
observer.observe(bar)

// Count real mouse presses on the window.
//
// Main reads this in `--probe` mode to answer a question nothing else can: when
// click-through is on, did a synthetic click at the bar's own coordinates reach
// the bar or pass through it? A counter on the window is the ground truth, and
// it needs no IPC channel — main just evaluates this expression.
window.__dsmClicks = 0
window.addEventListener('mousedown', () => {
  window.__dsmClicks += 1
}, true)

// Paint the system theme before the main process answers, so there is no flash.
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

applyLanguage()
void api.getState().then(setState)
