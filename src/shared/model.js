/**
 * Pure client-half logic: option normalization/persistence, value formatting,
 * tile geometry, and the snapshot → view-model reduction.
 *
 * Everything here is framework-free and DOM-free. The React components in
 * `tile.jsx` render the view model this module produces, so all formatting and
 * severity rules are unit-testable without a renderer.
 */

/** Storage key for the persisted tile options. */
export const STORAGE_KEY = 'dsh-system-monitor:options'

/** Locale namespace registered with the DSH locale service. */
export const LOCALE_NS = 'dsh-system-monitor'

/** Poll cadences the settings panel offers, in milliseconds. */
export const INTERVAL_CHOICES = [1000, 1500, 2000, 3000, 5000, 10000]

/** Tile options and their defaults. */
export const DEFAULT_OPTIONS = Object.freeze({
  enabled: true,
  intervalMs: 1500,
  opacity: 0.94,
  position: null,
  showCpu: true,
  showCpuTemperature: true,
  showMemory: true,
  showGpu: true,
  showGpuTemperature: true,
  showGpuMemory: true,
  showPower: false,
  showNetwork: true,
})

const MIN_OPACITY = 0.4
const MAX_OPACITY = 1
const MIN_INTERVAL = 500
const MAX_INTERVAL = 60000

/** Inclusive bounds for every numeric option, keyed by option name. */
const NUMERIC_BOUNDS = {
  opacity: [MIN_OPACITY, MAX_OPACITY],
  intervalMs: [MIN_INTERVAL, MAX_INTERVAL],
}

/** Clamp a number into a range, falling back when it is not finite. */
function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Coerce a value to boolean with an explicit fallback for non-booleans. */
function toBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize persisted or partially-supplied options into a complete, valid set.
 * Unknown keys are dropped and out-of-range numbers are clamped, so a corrupted
 * localStorage entry can never produce an unusable tile.
 */
export function normalizeOptions(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const options = {}
  for (const [key, fallback] of Object.entries(DEFAULT_OPTIONS)) {
    const value = source[key]
    if (typeof fallback === 'boolean') {
      options[key] = toBoolean(value, fallback)
    } else if (typeof fallback === 'number') {
      const [min, max] = NUMERIC_BOUNDS[key] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
      options[key] = clampNumber(value, min, max, fallback)
    } else if (key === 'position') {
      options[key] = normalizePosition(value)
    } else {
      options[key] = value === undefined ? fallback : value
    }
  }
  return options
}

/** Accept only a `{x, y}` pair of finite numbers; anything else means "auto". */
export function normalizePosition(value) {
  if (value === null || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * A localStorage-shaped adapter (`getItem`/`setItem`/`removeItem`).
 *
 * Keeping the DOM shape — rather than a bespoke `get`/`set` pair — means one
 * interface runs through the whole module and a caller's own storage stub drops
 * straight in. Falls back to an in-memory map whenever the page's storage is
 * unavailable or throws (private mode, blocked cookies, quota), because a
 * monitoring widget must never break the host application.
 */
export function createSafeStorage(backing) {
  let store = backing
  if (store === undefined) {
    try {
      store = globalThis.localStorage ?? null
    } catch {
      store = null
    }
  }
  const memory = new Map()
  const usable = store !== null && typeof store?.getItem === 'function'

  return {
    getItem(key) {
      if (usable) {
        try {
          const value = store.getItem(key)
          if (value !== null && value !== undefined) return value
        } catch {
          /* fall through to the in-memory copy */
        }
      }
      return memory.has(key) ? memory.get(key) : null
    },
    setItem(key, value) {
      const text = String(value)
      memory.set(key, text)
      if (!usable) return
      try {
        store.setItem(key, text)
      } catch {
        /* quota or blocked storage: the in-memory copy above still works */
      }
    },
    removeItem(key) {
      memory.delete(key)
      if (!usable) return
      try {
        store.removeItem(key)
      } catch {
        /* ignore */
      }
    },
  }
}

/** Read one key without ever throwing. */
function readStored(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null
  } catch {
    return null
  }
}

/** Write one key without ever throwing. */
function writeStored(storage, key, value) {
  try {
    storage?.setItem?.(key, value)
  } catch {
    /* ignore */
  }
}

/** Read and normalize persisted options. */
export function loadOptions(storage) {
  const raw = readStored(storage, STORAGE_KEY)
  if (typeof raw !== 'string' || raw === '') return { ...DEFAULT_OPTIONS }
  try {
    return normalizeOptions(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_OPTIONS }
  }
}

/** Persist options. */
export function saveOptions(storage, options) {
  writeStored(storage, STORAGE_KEY, JSON.stringify(options))
}

/**
 * A tiny external store consumed by `useSyncExternalStore`. Both the tile and
 * the settings panel read the same instance, so an option changed in Settings
 * is visible in the tile on the next paint.
 *
 * @param options.storage - an optional localStorage-shaped backing; defaults to
 *   the page's `localStorage` through {@link createSafeStorage}.
 */
export function createOptionsStore(options = {}) {
  const storage = createSafeStorage(options.storage)
  let state = loadOptions(storage)
  const listeners = new Set()

  const emit = () => {
    for (const listener of [...listeners]) listener()
  }

  return {
    /** Current options object (a stable reference until the next change). */
    getSnapshot: () => state,
    /** Subscribe to changes; returns the unsubscribe. */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Merge a patch, normalize, persist, and notify. */
    set(patch) {
      const next = normalizeOptions({ ...state, ...patch })
      if (JSON.stringify(next) === JSON.stringify(state)) return
      state = next
      saveOptions(storage, state)
      emit()
    },
    /** Restore defaults (keeping the tile enabled). */
    reset() {
      this.set({ ...DEFAULT_OPTIONS, enabled: true })
    },
  }
}

/**
 * Clamp a dragged position so the tile stays fully inside the viewport.
 * @param position - the requested `{x, y}`.
 * @param size - the tile's `{width, height}`.
 * @param viewport - the window's `{width, height}`.
 */
export function clampTilePosition(position, size, viewport) {
  const margin = 4
  const maxX = Math.max(margin, viewport.width - size.width - margin)
  const maxY = Math.max(margin, viewport.height - size.height - margin)
  return {
    x: Math.round(Math.min(maxX, Math.max(margin, position.x))),
    y: Math.round(Math.min(maxY, Math.max(margin, position.y))),
  }
}

/** Default resting place: just below the top-right corner, clear of the shell chrome. */
export function defaultTilePosition(size, viewport) {
  return clampTilePosition(
    { x: viewport.width - size.width - 20, y: 76 },
    size,
    viewport
  )
}

/**
 * Format a byte count the way a system monitor does: 1024-based units, labelled
 * GB/MB (matching Windows Task Manager and macOS Activity Monitor).
 * @returns e.g. `"19.4 GB"`, or null when the value is unusable.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null
  const gib = bytes / 1024 ** 3
  if (gib >= 1) return `${gib.toFixed(gib >= 100 ? 0 : 1)} GB`
  const mib = bytes / 1024 ** 2
  if (mib >= 1) return `${mib.toFixed(0)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/**
 * Format a used/total pair in **one shared unit**, which is how a system monitor
 * writes it (`13.4/31.2 GB`). Sharing the unit keeps the line short on a 300px
 * tile and removes the ambiguity of comparing `0 KB` against `11.9 GB`.
 * A zero used-count prints as a bare `0` rather than `0.0`.
 *
 * @returns e.g. `"13.4/31.2 GB"`, or a single formatted value when the total is
 *   unusable.
 */
export function formatBytePair(usedBytes, totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return formatBytes(usedBytes)
  const gib = totalBytes / 1024 ** 3
  const useGib = gib >= 1
  const scale = useGib ? 1024 ** 3 : 1024 ** 2
  const unit = useGib ? 'GB' : 'MB'
  const digits = useGib && gib < 100 ? 1 : 0
  const one = (bytes) => {
    if (!Number.isFinite(bytes)) return '—'
    return bytes === 0 ? '0' : (bytes / scale).toFixed(digits)
  }
  return `${one(usedBytes)}/${one(totalBytes)} ${unit}`
}

/** Format a percentage, keeping one decimal only below 10%. */export function formatPercent(value) {
  if (!Number.isFinite(value)) return null
  const clamped = Math.min(100, Math.max(0, value))
  return `${clamped < 10 && clamped > 0 ? clamped.toFixed(1) : Math.round(clamped)}%`
}

/** Format a Celsius reading. */
export function formatTemperature(celsius) {
  if (!Number.isFinite(celsius)) return null
  return `${celsius.toFixed(celsius >= 100 ? 0 : 1).replace(/\.0$/, '')}°C`
}

/** Format a wattage reading. */
export function formatWatts(watts) {
  if (!Number.isFinite(watts)) return null
  return `${watts.toFixed(watts >= 100 ? 0 : 1)} W`
}

/** Severity bucket for a load percentage. */
export function severityOf(percent) {
  if (!Number.isFinite(percent)) return 'unknown'
  if (percent >= 90) return 'hot'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/** Severity bucket for a temperature. Laptop CPUs idle hot, so the bar is high. */
export function temperatureSeverity(celsius) {
  if (!Number.isFinite(celsius)) return 'unknown'
  if (celsius >= 90) return 'hot'
  if (celsius >= 75) return 'warn'
  return 'ok'
}

/**
 * Format a throughput in bytes per second, the way a network readout writes it:
 * `1.2 MB/s`, `240 KB/s`, `0 B/s`.
 * @returns the formatted rate, or null when it is unusable.
 */
export function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return null
  const steps = [
    [1024 ** 3, 'GB/s'],
    [1024 ** 2, 'MB/s'],
    [1024, 'KB/s'],
  ]
  for (const [scale, unit] of steps) {
    if (bytesPerSecond >= scale) {
      const value = bytesPerSecond / scale
      return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`
    }
  }
  return `${Math.round(bytesPerSecond)} B/s`
}

/**
 * Reduce a host snapshot to the items the tile paints.
 *
 * This is the whole display contract, and it is deliberately **text-only**: each
 * item carries a localized label key, one headline value, and a list of trailing
 * detail strings. `tile.jsx` lays them out along one line and adds no gauges,
 * bars or charts — the tile is a readout, not a dashboard.
 *
 * Item names (CPU model, GPU model) are deliberately **not** part of the visible
 * line; they ride in `title` so the readout stays narrow without losing them.
 *
 * @param snapshot - the payload from `/api/dsh-system-monitor/snapshot`.
 * @param options - resolved tile options.
 * @returns `{ ok, rows, errors, updatedAt, host }`.
 */
export function buildViewModel(snapshot, options) {
  const resolved = options ?? DEFAULT_OPTIONS
  if (snapshot === null || typeof snapshot !== 'object') {
    return { ok: false, rows: [], errors: [], updatedAt: null, host: null }
  }

  const rows = []
  if (resolved.showCpu !== false) rows.push(cpuRow(snapshot.cpu, resolved))
  if (resolved.showMemory !== false) rows.push(memoryRow(snapshot.memory))
  if (resolved.showGpu !== false) {
    const gpus = Array.isArray(snapshot.gpus) ? snapshot.gpus : []
    gpus.forEach((gpu, index) => rows.push(gpuRow(gpu, resolved, index, gpus.length)))
  }
  if (resolved.showNetwork !== false) rows.push(networkRow(snapshot.network))

  return {
    ok: true,
    rows: rows.filter((row) => row !== null),
    errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
    updatedAt: Number.isFinite(snapshot.ts) ? snapshot.ts : null,
    host: snapshot.host ?? null,
  }
}

/** Build the CPU item: utilization, then temperature. */
function cpuRow(cpu, options) {
  if (cpu === null || typeof cpu !== 'object') return null
  const details = []
  if (options.showCpuTemperature !== false && Number.isFinite(cpu.temperature)) {
    details.push({ key: 'temp', text: formatTemperature(cpu.temperature), tone: temperatureSeverity(cpu.temperature) })
  }
  const cores = Number.isFinite(cpu.cores) ? cpu.cores : null
  const model = typeof cpu.model === 'string' ? cpu.model.trim() : ''
  return {
    key: 'cpu',
    labelKey: 'labelCpu',
    labelParams: undefined,
    // `32T` keeps the tooltip language-neutral, so no `t` is needed here.
    title: [model, cores === null ? null : `${cores}T`].filter(Boolean).join(' · ') || null,
    valueText: formatPercent(cpu.usage),
    severity: severityOf(cpu.usage),
    details,
  }
}

/** Build the memory item. */
function memoryRow(memory) {
  if (memory === null || typeof memory !== 'object') return null
  const size = formatBytePair(memory.usedBytes, memory.totalBytes)
  const details = []
  if (size !== null) details.push({ key: 'size', text: size, tone: 'muted' })
  return {
    key: 'memory',
    labelKey: 'labelMem',
    labelParams: undefined,
    title: null,
    valueText: formatPercent(memory.usage),
    severity: severityOf(memory.usage),
    details,
  }
}

/** Build one item per GPU. */
function gpuRow(gpu, options, index, total) {
  if (gpu === null || typeof gpu !== 'object') return null
  const details = []
  if (options.showGpuTemperature !== false && Number.isFinite(gpu.temperature)) {
    details.push({ key: 'temp', text: formatTemperature(gpu.temperature), tone: temperatureSeverity(gpu.temperature) })
  }
  if (options.showGpuMemory !== false && gpu.memory !== null && typeof gpu.memory === 'object') {
    const size = formatBytePair(gpu.memory.usedBytes, gpu.memory.totalBytes)
    if (size !== null) details.push({ key: 'vram', text: size, tone: 'muted' })
  }
  if (options.showPower === true && Number.isFinite(gpu.powerWatts)) {
    details.push({ key: 'power', text: formatWatts(gpu.powerWatts), tone: 'muted' })
  }
  const position = Number.isFinite(gpu.index) ? gpu.index : index
  return {
    key: `gpu-${position}`,
    // A single adapter reads "GPU"; a hybrid laptop numbers them.
    labelKey: total > 1 ? 'labelGpuN' : 'labelGpu',
    labelParams: total > 1 ? { n: position } : undefined,
    title: typeof gpu.name === 'string' ? gpu.name : null,
    valueText: formatPercent(gpu.usage),
    severity: severityOf(gpu.usage),
    details,
  }
}

/**
 * Build the network item: download as the headline value, upload as a detail.
 * Both directions are requested by design — the arrows are what distinguish them.
 */
function networkRow(network) {
  if (network === null || typeof network !== 'object') return null
  const down = formatRate(network.downloadBytesPerSec)
  const up = formatRate(network.uploadBytesPerSec)
  if (down === null && up === null) {
    // Nothing measurable (unsupported platform, or no baseline yet).
    return {
      key: 'network',
      labelKey: 'labelNet',
      labelParams: undefined,
      title: countedAdapters(network),
      valueText: null,
      severity: 'unknown',
      details: [],
    }
  }
  const details = []
  if (up !== null) details.push({ key: 'up', text: `↑ ${up}`, tone: 'muted' })
  return {
    key: 'network',
    labelKey: 'labelNet',
    labelParams: undefined,
    title: countedAdapters(network),
    valueText: down === null ? null : `↓ ${down}`,
    // Throughput has no meaningful "hot" threshold, so it never turns red.
    severity: 'ok',
    details,
  }
}

/** Tooltip text naming the adapters that contributed to the total. */
function countedAdapters(network) {
  const interfaces = Array.isArray(network.interfaces) ? network.interfaces : []
  const names = interfaces.filter((entry) => entry?.counted === true).map((entry) => entry.name)
  if (names.length === 0) return typeof network.source === 'string' ? network.source : null
  return names.join(' · ')
}
