/**
 * Persisted window behaviour, and the pure normalizer behind it.
 *
 * Kept separate from the IO (`store.js`) so the rules — what a missing or
 * corrupted settings file means, and how a stale position is treated — can be
 * tested without touching the disk.
 */

/** Settings file name inside the app's userData directory. */
export const SETTINGS_FILE = 'settings.json'

/** Palette choices: `auto` follows the Windows light/dark setting. */
export const THEMES = ['auto', 'light', 'dark']

/**
 * Opacity bounds for the capsule's background.
 *
 * The floor is not 0: a completely transparent capsule would leave the text
 * floating over whatever is behind it, which is unreadable rather than subtle.
 */
export const MIN_OPACITY = 0.2
export const MAX_OPACITY = 1

/** Everything the bar remembers between launches. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Dock to the top edge and auto-hide there. */
  pinned: false,
  /** Let mouse events fall through the bar to whatever is behind it. */
  clickThrough: false,
  /** Keep the window above other windows. */
  alwaysOnTop: true,
  /** Start the bar when the user signs in. */
  openAtLogin: false,
  /** `auto` | `light` | `dark`. */
  theme: 'auto',
  /** Background opacity of the capsule: {@link MIN_OPACITY}–{@link MAX_OPACITY}. */
  opacity: 0.94,
  /** `{x, y}` for the floating (unpinned) mode; null means "top-right". */
  position: null,
  /** UI language: `auto` follows the OS, otherwise a two-letter code. */
  language: 'auto',
})

const LANGUAGES = new Set(['auto', 'zh', 'en'])

/** Accept only a `{x, y}` pair of finite numbers; anything else means "auto". */
export function normalizePoint(value) {
  if (value === null || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * Clamp an opacity to the usable range, at 1% resolution.
 *
 * The slider cannot express anything outside the range, so a hand-edited file is
 * the only way to get one; clamping keeps it visible instead of rejecting it.
 * Values that are not numbers at all (`null`, `true`, `"clear"`, `""`) fall back
 * instead of clamping — `Number(null)` is 0, and silently turning a missing value
 * into "almost fully transparent" is not a sensible reading of a typo.
 */
export function normalizeOpacity(value, fallback = DEFAULT_SETTINGS.opacity) {
  if (value === null || value === undefined || typeof value === 'boolean') return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  const clamped = Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, number))
  return Math.round(clamped * 100) / 100
}

/** Coerce to boolean, keeping the fallback for anything that is not a boolean. */
function toBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize settings read from disk.
 *
 * A missing, partial, or hand-edited file must never leave the app in a state it
 * cannot draw: unknown keys are dropped, non-booleans keep their default, an
 * unusable position becomes null (which means "put me somewhere sensible"), an
 * out-of-range opacity is clamped, and an unknown language or theme falls back to
 * `auto`.
 *
 * @param raw - parsed JSON, or anything else.
 * @returns a complete settings object.
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    pinned: toBoolean(source.pinned, DEFAULT_SETTINGS.pinned),
    clickThrough: toBoolean(source.clickThrough, DEFAULT_SETTINGS.clickThrough),
    alwaysOnTop: toBoolean(source.alwaysOnTop, DEFAULT_SETTINGS.alwaysOnTop),
    openAtLogin: toBoolean(source.openAtLogin, DEFAULT_SETTINGS.openAtLogin),
    theme: THEMES.includes(source.theme) ? source.theme : DEFAULT_SETTINGS.theme,
    opacity: normalizeOpacity(source.opacity, DEFAULT_SETTINGS.opacity),
    position: normalizePoint(source.position),
    language: LANGUAGES.has(source.language) ? source.language : DEFAULT_SETTINGS.language,
  }
}
