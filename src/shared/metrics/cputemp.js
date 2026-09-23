import { readdir, readFile } from 'node:fs/promises'
import { runCommand } from './exec.js'
import { milliCelsiusToCelsius, readTypeperfFrame, round, toFiniteNumber } from './parse.js'

/**
 * The Windows performance-counter path used for CPU temperature.
 *
 * Windows exposes no CPU die temperature through Node, and every WMI route
 * (`MSAcpi_ThermalZoneTemperature`, vendor namespaces) is either denied to
 * non-elevated callers or requires third-party drivers. What *is* available to
 * any caller is the PDH counter set `Thermal Zone Information`, whose
 * `Temperature` counter is published by the ACPI driver for each thermal zone.
 * `typeperf` is the zero-dependency way to read a PDH counter once.
 */
export const WINDOWS_THERMAL_COUNTER = '\\Thermal Zone Information(*)\\Temperature'

/** Lower/upper Celsius bounds outside which a reading is treated as garbage. */
const PLAUSIBLE_MIN_C = -40
const PLAUSIBLE_MAX_C = 150

/**
 * Convert one raw ACPI thermal value to Celsius.
 *
 * **Unit determination (empirical, not assumed).** The PDH counter is widely
 * documented as "degrees Kelvin", but ACPI's underlying `_TMP` is deci-Kelvin —
 * and deci-Kelvin is impossible for the values a real machine reports (355
 * deci-Kelvin is 35.5 K). Measured on a Windows 11 AMD laptop: the counter idles
 * at ~355 and plateaus at ~367 under sustained 4-thread load, i.e. 82 °C → 94 °C,
 * which is exactly a laptop CPU settling just under its 95 °C throttle. Read as
 * deci-Celsius the same trace would be 35.5 °C → 36.7 °C, a 1.2 °C rise under
 * full load, which no physical package does. Kelvin is therefore the unit, and
 * `scale: 'decikelvin' | 'decicelsius'` stays available for sources that differ.
 *
 * @param raw - the raw counter value.
 * @param scale - `auto` (default), `kelvin`, `decikelvin`, or `decicelsius`.
 * @returns rounded Celsius, or null when zero/implausible/unparseable.
 */
export function thermalRawToCelsius(raw, scale = 'auto') {
  const value = toFiniteNumber(raw)
  if (value === null) return null
  // ACPI reports 0 for "sensor not present"; 0 K is not a temperature.
  if (value === 0) return null

  let mode = scale
  if (mode === 'auto') mode = value > 1000 ? 'decikelvin' : 'kelvin'

  let celsius
  switch (mode) {
    case 'decikelvin':
      celsius = value / 10 - 273.15
      break
    case 'decicelsius':
      celsius = value / 10
      break
    case 'kelvin':
    default:
      celsius = value - 273.15
      break
  }

  if (!Number.isFinite(celsius) || celsius < PLAUSIBLE_MIN_C || celsius > PLAUSIBLE_MAX_C) return null
  return round(celsius, 1)
}

/**
 * Parse `typeperf "\Thermal Zone Information(*)\Temperature" -sc 1` output.
 * @param text - raw stdout.
 * @param scale - unit override passed through to {@link thermalRawToCelsius}.
 * @returns `{ zones, celsius }` where `celsius` is the hottest zone, or null
 *   when no zone yielded a plausible reading.
 */
export function parseThermalCounters(text, scale = 'auto') {
  const frame = readTypeperfFrame(text)
  if (frame === null) return null

  const zones = []
  for (let index = 1; index < frame.header.length; index += 1) {
    const celsius = thermalRawToCelsius(frame.values[index], scale)
    if (celsius === null) continue
    zones.push({ name: thermalZoneName(frame.header[index]), celsius })
  }
  if (zones.length === 0) return null
  zones.sort((a, b) => b.celsius - a.celsius)
  return { zones, celsius: zones[0].celsius }
}

/** Extract the ACPI zone instance (`\_SB.ECTZ`) out of a counter path. */
export function thermalZoneName(counterPath) {
  const match = /Thermal Zone Information\((.*)\)\\Temperature/.exec(counterPath ?? '')
  return match === null ? String(counterPath ?? 'thermal zone') : match[1]
}

/**
 * Read CPU temperature on Windows through the PDH thermal-zone counters.
 * @returns `{ celsius, zones, source }` or `{ celsius: null, error }`.
 */
export async function readWindowsCpuTemperature(options = {}) {
  const exec = options.exec ?? runCommand
  const scale = options.scale ?? 'auto'
  const result = await exec('typeperf.exe', [WINDOWS_THERMAL_COUNTER, '-sc', '1'], {
    timeoutMs: options.timeoutMs ?? 4000,
    platform: options.platform ?? process.platform,
  })
  if (!result.ok) {
    return { celsius: null, zones: [], source: 'acpi-thermal-zone', error: result.error ?? 'typeperf failed' }
  }
  const parsed = parseThermalCounters(result.stdout, scale)
  if (parsed === null) {
    return { celsius: null, zones: [], source: 'acpi-thermal-zone', error: 'no plausible thermal zone reading' }
  }
  return { ...parsed, source: 'acpi-thermal-zone', error: null }
}

/**
 * Read CPU temperature on Linux from the kernel's own sensor files: ACPI
 * thermal zones and hwmon chips whose driver name marks them as CPU sensors.
 * @returns `{ celsius, zones, source }` or `{ celsius: null, error }`.
 */
export async function readLinuxCpuTemperature(options = {}) {
  const fs = options.fs ?? { readdir, readFile }
  const zones = []

  for (const entry of await safeList(fs, '/sys/class/thermal')) {
    if (!entry.startsWith('thermal_zone')) continue
    const base = `/sys/class/thermal/${entry}`
    const celsius = milliCelsiusToCelsius(await safeRead(fs, `${base}/temp`))
    if (celsius === null) continue
    const type = (await safeRead(fs, `${base}/type`))?.trim()
    zones.push({ name: type !== undefined && type !== '' ? type : entry, celsius })
  }

  const cpuHwmon = new Set(['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'acpitz'])
  for (const entry of await safeList(fs, '/sys/class/hwmon')) {
    const base = `/sys/class/hwmon/${entry}`
    const name = (await safeRead(fs, `${base}/name`))?.trim()
    if (name === undefined || !cpuHwmon.has(name)) continue
    for (const file of await safeList(fs, base)) {
      if (!/^temp\d+_input$/.test(file)) continue
      const celsius = milliCelsiusToCelsius(await safeRead(fs, `${base}/${file}`))
      if (celsius === null) continue
      zones.push({ name: `${name}/${file.replace('_input', '')}`, celsius })
    }
  }

  if (zones.length === 0) {
    return { celsius: null, zones: [], source: 'linux-hwmon', error: 'no readable CPU thermal sensor under /sys' }
  }
  zones.sort((a, b) => b.celsius - a.celsius)
  return { celsius: zones[0].celsius, zones, source: 'linux-hwmon', error: null }
}

/**
 * Platform dispatch for CPU temperature. macOS is reported as unsupported
 * rather than guessed: the only real source is `powermetrics`, which requires
 * root, and this plugin never escalates privileges.
 */
export async function sampleCpuTemperature(options = {}) {
  const platform = options.platform ?? process.platform
  try {
    if (platform === 'win32') return await readWindowsCpuTemperature(options)
    if (platform === 'linux') return await readLinuxCpuTemperature(options)
    return {
      celsius: null,
      zones: [],
      source: 'unsupported',
      error: `CPU temperature is not available on ${platform} without elevated privileges`,
    }
  } catch (error) {
    return {
      celsius: null,
      zones: [],
      source: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** `readdir` that yields [] instead of throwing on a missing directory. */
async function safeList(fs, path) {
  try {
    return await fs.readdir(path)
  } catch {
    return []
  }
}

/** `readFile` that yields undefined instead of throwing. */
async function safeRead(fs, path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return undefined
  }
}
