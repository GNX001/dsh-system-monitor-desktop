import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, MAX_OPACITY, MIN_OPACITY, THEMES, normalizeOpacity, normalizePoint, normalizeSettings } from '../src/main/settings.js'
import { readJson, writeJson } from '../src/main/store.js'
import { APP_STRINGS, resolveLanguage, stringsFor } from '../src/shared/strings.js'

test('normalizeSettings fills in every missing field', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings('nonsense'), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings([]), { ...DEFAULT_SETTINGS })
})

test('normalizeSettings keeps valid values and coerces the rest', () => {
  const settings = normalizeSettings({
    pinned: true,
    clickThrough: false,
    alwaysOnTop: 'yes',
    position: { x: 10.6, y: -4.2 },
    language: 'en',
    unknown: 'dropped',
  })
  assert.equal(settings.pinned, true)
  assert.equal(settings.clickThrough, false)
  assert.equal(settings.alwaysOnTop, DEFAULT_SETTINGS.alwaysOnTop, 'a non-boolean keeps the default')
  assert.deepEqual(settings.position, { x: 11, y: -4 })
  assert.equal(settings.language, 'en')
  assert.equal('unknown' in settings, false)
})

test('normalizeSettings rejects an unusable position and language', () => {
  assert.equal(normalizeSettings({ position: 'top right' }).position, null)
  assert.equal(normalizeSettings({ position: { x: Number.NaN, y: 3 } }).position, null)
  assert.equal(normalizeSettings({ position: { x: 1 } }).position, null)
  assert.deepEqual(normalizePoint({ x: 0, y: 0 }), { x: 0, y: 0 }, 'the origin is a real position')
  assert.equal(normalizeSettings({ language: 'de' }).language, 'auto')
  assert.equal(normalizeSettings({ language: 'ZH' }).language, 'auto', 'the codes are exact')
})

test('normalizeSettings validates the theme, the opacity and the startup flag', () => {
  assert.deepEqual(THEMES, ['auto', 'light', 'dark'])
  assert.equal(normalizeSettings({ theme: 'dark' }).theme, 'dark')
  assert.equal(normalizeSettings({ theme: 'light' }).theme, 'light')
  assert.equal(normalizeSettings({ theme: 'DARK' }).theme, 'auto', 'the values are exact')
  assert.equal(normalizeSettings({ theme: 'sepia' }).theme, 'auto')

  assert.equal(normalizeSettings({ opacity: 0.5 }).opacity, 0.5)
  assert.equal(normalizeSettings({ opacity: 1 }).opacity, MAX_OPACITY)
  assert.equal(normalizeSettings({ opacity: 'clear' }).opacity, DEFAULT_SETTINGS.opacity)
  assert.equal(normalizeSettings({ opacity: null }).opacity, DEFAULT_SETTINGS.opacity)

  assert.equal(normalizeSettings({ openAtLogin: true }).openAtLogin, true)
  assert.equal(normalizeSettings({ openAtLogin: false }).openAtLogin, false)
  assert.equal(normalizeSettings({ openAtLogin: 'yes' }).openAtLogin, false, 'a non-boolean keeps the default')
})

test('an out-of-range opacity is clamped into the usable range', () => {
  // The floor is deliberate: a fully transparent capsule would leave the text
  // floating over whatever is behind it.
  assert.equal(normalizeOpacity(0), MIN_OPACITY)
  assert.equal(normalizeOpacity(-3), MIN_OPACITY)
  assert.equal(normalizeOpacity(5), MAX_OPACITY)
  assert.equal(normalizeOpacity(0.5678), 0.57, 'stored at 1% resolution, matching the slider')
  assert.equal(normalizeOpacity(0.999), 1)
  assert.equal(normalizeOpacity(Number.NaN, 0.7), 0.7)
  assert.ok(MIN_OPACITY > 0, 'never fully transparent')
})

test('a corrupt settings file degrades to the defaults instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsm-settings-'))
  const file = join(dir, 'settings.json')
  try {
    assert.deepEqual(await readJson(file, DEFAULT_SETTINGS), { ...DEFAULT_SETTINGS }, 'missing file')

    await writeFile(file, '{ not json', 'utf8')
    assert.deepEqual(await readJson(file, DEFAULT_SETTINGS), { ...DEFAULT_SETTINGS }, 'invalid json')

    await writeJson(file, { pinned: true, position: { x: 5, y: 6 } })
    const roundTripped = normalizeSettings(await readJson(file, null))
    assert.equal(roundTripped.pinned, true)
    assert.deepEqual(roundTripped.position, { x: 5, y: 6 })

    // The original text is recoverable and formatted for a human to edit.
    const text = await readFile(file, 'utf8')
    assert.match(text, /"pinned": true/)
    assert.ok(text.endsWith('\n'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveLanguage prefers the setting, then the system locale', () => {
  assert.equal(resolveLanguage('zh', 'en-US'), 'zh')
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en')
  assert.equal(resolveLanguage('auto', 'zh-CN'), 'zh')
  assert.equal(resolveLanguage('auto', 'zh'), 'zh')
  assert.equal(resolveLanguage('auto', 'en-GB'), 'en')
  assert.equal(resolveLanguage('auto', 'de-DE'), 'en', 'anything else falls back to English')
  assert.equal(resolveLanguage('auto', undefined), 'en')
})

test('both string tables carry the same keys', () => {
  assert.deepEqual(Object.keys(APP_STRINGS.zh).sort(), Object.keys(APP_STRINGS.en).sort())
  assert.equal(stringsFor('zh').trayQuit, '退出')
  assert.equal(stringsFor('en').trayQuit, 'Quit')
  assert.equal(stringsFor('de'), APP_STRINGS.en, 'an unknown language falls back to English')
  for (const [key, value] of Object.entries(APP_STRINGS.zh)) {
    assert.equal(typeof value, 'string', key)
    assert.ok(key in APP_STRINGS.en, `${key} is missing from the English table`)
  }
})
