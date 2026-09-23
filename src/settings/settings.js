import { resolveLanguage, stringsFor } from '../shared/strings.js'

/**
 * The settings window.
 *
 * The controls are built once from the dictionary and then kept in sync in
 * place rather than re-rendered: the window is small, and rebuilding the DOM on
 * every change would fight the one control that has continuous input — the
 * opacity slider. A language change is the single case that rebuilds, because
 * then every label moves.
 *
 * Nothing here decides policy. Each control reports an intent
 * (`api.set({key: value})`) and draws whatever the main process says the state
 * now is, so a rejected or clamped value cannot leave the UI lying.
 */

const api = window.settingsApi

const heading = document.getElementById('heading')
const intro = document.getElementById('intro')
const warning = document.getElementById('warning')
const form = document.getElementById('form')
const footnote = document.getElementById('footnote')

/** Resolved UI language and its dictionary. */
let language = 'en'
let ui = stringsFor(language)
let state = { pinned: false, clickThrough: false, alwaysOnTop: true, openAtLogin: false, theme: 'auto', opacity: 0.94, language: 'auto' }
let built = false

const switches = new Map()
const segments = new Map()
let slider = null
let sliderOutput = null
let shortcutValue = null
let visibilityButton = null
let loginHint = null

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A card row: label + hint on the left, one control slot on the right. */
function row(labelKey, hintKey) {
  const wrapper = el('div', 'row')
  const text = el('div', 'row-text')
  text.append(el('span', 'row-label', ui[labelKey]))
  if (hintKey !== undefined && ui[hintKey] !== undefined) text.append(el('span', 'row-hint', ui[hintKey]))
  const control = el('div', 'row-control')
  wrapper.append(text, control)
  return { wrapper, control }
}

function switchRow(key, labelKey, hintKey) {
  const { wrapper, control } = row(labelKey, hintKey)
  const track = el('span', 'switch')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.setAttribute('aria-label', ui[labelKey])
  input.addEventListener('change', () => {
    void api.set({ [key]: input.checked }).then(applyState)
  })
  track.append(input, el('span', 'track'))
  control.append(track)
  switches.set(key, input)
  return wrapper
}

/**
 * The sign-in switch, whose hint can change: a portable build that has been moved
 * since it was registered keeps a stale path, and the user has no way to guess
 * that from a switch that still says "on".
 */
function loginItemRow() {
  const wrapper = switchRow('openAtLogin', 'openAtLogin', 'openAtLoginHint')
  loginHint = wrapper.querySelector('.row-hint')
  return wrapper
}

function segmentRow(key, labelKey, hintKey, options) {
  const { wrapper, control } = row(labelKey, hintKey)
  const group = el('div', 'segments')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', ui[labelKey])
  const inputs = []
  for (const [value, text] of options) {
    const label = el('label')
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = key
    input.value = value
    input.addEventListener('change', () => {
      if (input.checked) void api.set({ [key]: value }).then(applyState)
    })
    label.append(input, el('span', undefined, text))
    group.append(label)
    inputs.push(input)
  }
  control.append(group)
  segments.set(key, inputs)
  return wrapper
}

/** 20–100%, matching MIN_OPACITY/MAX_OPACITY on the main-process side. */
function sliderRow(key, labelKey, hintKey) {
  const { wrapper, control } = row(labelKey, hintKey)
  const holder = el('div', 'slider')
  const input = document.createElement('input')
  input.type = 'range'
  input.min = '20'
  input.max = '100'
  input.step = '1'
  input.setAttribute('aria-label', ui[labelKey])
  const output = el('output')
  input.addEventListener('input', () => {
    output.textContent = `${input.value}%`
    void api.set({ [key]: Number(input.value) / 100 }).then(applyState)
  })
  holder.append(input, output)
  control.append(holder)
  slider = input
  sliderOutput = output
  return wrapper
}

/** A row whose control is one or more buttons. */
function buttonRow(labelKey, hintKey, actions) {
  const { wrapper, control } = row(labelKey, hintKey)
  for (const { label, name, danger } of actions) {
    const button = el('button', danger === true ? 'button danger' : 'button', label)
    button.type = 'button'
    button.addEventListener('click', () => {
      void api.action(name).then(applyState)
    })
    control.append(button)
  }
  return wrapper
}

function section(titleKey, rows) {
  const wrapper = el('section', 'section')
  wrapper.append(el('h2', undefined, ui[titleKey]))
  const card = el('div', 'card')
  card.append(...rows)
  wrapper.append(card)
  return wrapper
}

function build() {
  form.replaceChildren()
  switches.clear()
  segments.clear()

  heading.textContent = ui.settingsTitle
  intro.textContent = ui.settingsIntro
  footnote.textContent = ui.settingsFootNote

  form.append(
    section('sectionBar', [
      switchRow('pinned', 'pinned', 'pinnedHint'),
      switchRow('clickThrough', 'clickThrough', 'clickThroughHint'),
      switchRow('alwaysOnTop', 'alwaysOnTop', 'alwaysOnTopHint'),
    ]),
    section('sectionWindow', [
      segmentRow('theme', 'theme', 'themeHint', [
        ['auto', ui.themeAuto],
        ['light', ui.themeLight],
        ['dark', ui.themeDark],
      ]),
      sliderRow('opacity', 'opacity', 'opacityHint'),
      buttonRow('position', 'positionHint', [{ label: ui.resetPosition, name: 'reset-position' }]),
    ]),
    section('sectionGeneral', [
      loginItemRow(),
      segmentRow('language', 'language', undefined, [
        ['auto', ui.languageAuto],
        ['zh', '中文'],
        ['en', 'English'],
      ]),
      (() => {
        const { wrapper, control } = row('shortcutRow', undefined)
        shortcutValue = el('span', 'value')
        control.append(shortcutValue)
        return wrapper
      })(),
      (() => {
        const { wrapper, control } = row('position', undefined)
        visibilityButton = el('button', 'button', ui.hideBar)
        visibilityButton.type = 'button'
        visibilityButton.addEventListener('click', () => {
          void api
            .action(visibilityButton.textContent === ui.hideBar ? 'hide-bar' : 'show-bar')
            .then(applyState)
        })
        const folder = el('button', 'button', ui.openSettingsFolder)
        folder.type = 'button'
        folder.addEventListener('click', () => void api.action('open-folder'))
        const quit = el('button', 'button danger', ui.quit)
        quit.type = 'button'
        quit.addEventListener('click', () => void api.action('quit'))
        control.append(visibilityButton, folder, quit)
        return wrapper
      })(),
    ]),
  )

  built = true
  syncValues()
}

/** Draw the current state onto the existing controls. */
function syncValues() {
  for (const [key, input] of switches) input.checked = state[key] === true

  for (const [key, inputs] of segments) {
    for (const input of inputs) input.checked = input.value === state[key]
  }

  if (slider !== null) {
    const percent = Math.round((state.opacity ?? 0.94) * 100)
    // Never write the value the user is currently dragging.
    if (document.activeElement !== slider) slider.value = String(percent)
    if (sliderOutput !== null) sliderOutput.textContent = `${percent}%`
  }

  if (shortcutValue !== null) shortcutValue.textContent = state.shortcut || ui.shortcutUnavailable
  if (visibilityButton !== null) visibilityButton.textContent = state.visible === false ? ui.showBar : ui.hideBar

  if (loginHint !== null) {
    // A stale entry is the one failure a user cannot see for themselves.
    const stale = state.loginItemPath != null && state.execPath != null && state.loginItemPath !== state.execPath
    loginHint.textContent = stale ? `${ui.openAtLoginHint} ${ui.openAtLoginMoved}` : ui.openAtLoginHint
  }

  warning.hidden = state.clickThrough !== true
  warning.textContent = ui.clickThroughOn
}

function applyState(next) {
  if (next === null || next === undefined) return
  const previous = language
  state = { ...state, ...next }
  language = resolveLanguage(state.resolvedLanguage, navigator.language)
  ui = stringsFor(language)
  document.documentElement.dataset.theme = state.dark === false ? 'light' : 'dark'
  if (!built || language !== previous) build()
  else syncValues()
}

api.onChanged(applyState)
void api.get().then(applyState)
