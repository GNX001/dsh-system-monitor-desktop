/**
 * Persisted window behaviour, and the pure normalizer behind it.
 *
 * Kept separate from the IO (`store.js`) so the rules — what a missing or
 * corrupted settings file means, and how a stale position is treated — can be
 * tested without touching the disk.
 */

/** Settings file name inside the app's userData directory. */
export const SETTINGS_FILE = 'settings.json'

/** Everything the bar remembers between launches. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Dock to the top edge and auto-hide there. */
  pinned: false,
  /** Let mouse events fall through the bar to whatever is behind it. */
  clickThrough: false,
  /** Keep the window above other windows. */
  alwaysOnTop: true,
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

/** Coerce to boolean, keeping the fallback for anything that is not a boolean. */
function toBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize settings read from disk.
 *
 * A missing, partial, or hand-edited file must never leave the app in a state it
 * cannot draw: unknown keys are dropped, non-booleans keep their default, an
 * unusable position becomes null (which means "put me somewhere sensible"), and
 * an unknown language falls back to `auto`.
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
    position: normalizePoint(source.position),
    language: LANGUAGES.has(source.language) ? source.language : DEFAULT_SETTINGS.language,
  }
}
