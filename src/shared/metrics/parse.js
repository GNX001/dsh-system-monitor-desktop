/**
 * Pure parsing/number helpers shared by every metric collector. Nothing here
 * touches the OS, so the whole module is exercised directly by unit tests and
 * every collector's IO is kept to a thin wrapper around these functions.
 */

/** Clamp a number into 0..1; non-finite input becomes 0. */
export function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Round to `digits` decimals (default 1), preserving null. */
export function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Parse one tool/CSV field into a finite number, or null.
 * Handles the placeholder spellings PDH and nvidia-smi emit for counters a
 * platform does not implement: `N/A`, `[N/A]`, `[Not Supported]`, `-`, and the
 * empty string. Those must become null (rendered as `—`), never 0, so a
 * missing sensor is never reported as a cold one.
 */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^\[?\s*n\/?a\s*\]?$/i.test(trimmed)) return null
  if (/^\[?\s*not supported\s*\]?$/i.test(trimmed)) return null
  if (trimmed === '-' || trimmed === '--') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** Convert mebibytes to bytes, preserving null. */
export function mibToBytes(mib) {
  const value = toFiniteNumber(mib)
  return value === null ? null : value * 1024 * 1024
}

/**
 * Convert millidegrees Celsius (Linux/`hwmon` and `amdgpu` sysfs) to Celsius.
 *
 * An exact `0` is treated as "no reading", not as 0 °C: kernel sensor drivers
 * publish 0 when a sensor is absent, unpopulated, or unreadable this instant,
 * and reporting that as a genuine 0 °C reading would be worse than reporting
 * nothing at all.
 */
export function milliCelsiusToCelsius(milli) {
  const value = toFiniteNumber(milli)
  if (value === null || value === 0) return null
  return round(value / 1000, 1)
}

/** Percentage of `used` within `total`, or null when total is unusable. */
export function usagePercent(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null
  return round(clamp01(used / total) * 100, 1)
}

/**
 * Split one delimited line honoring double-quoted fields (so a quoted field may
 * contain the delimiter). Quotes are stripped from the result. This is the
 * reader behind both `typeperf` CSV and `nvidia-smi --format=csv` output.
 */
export function parseDelimitedLine(line, delimiter = ',') {
  const fields = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        current += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      fields.push(current)
      current = ''
      continue
    }
    current += char
  }
  fields.push(current)
  return fields.map((field) => field.trim())
}

/** Split raw tool output into non-empty, trimmed lines. */
export function splitLines(text) {
  if (typeof text !== 'string') return []
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * Pick the header line and the first sample row out of a `typeperf` run.
 * `typeperf` prints a blank line, the `(PDH-CSV 4.0)` header, one row per
 * sample, then progress chatter on stdout ("Exiting, please wait...", "The
 * command completed successfully."), so the sample row is identified by shape
 * rather than by position.
 *
 * @param text - raw stdout.
 * @returns the parsed header fields and the first sample's value fields, or
 *   null when either is missing.
 */
export function readTypeperfFrame(text) {
  const lines = splitLines(text)
  let header = null
  for (const line of lines) {
    if (line.includes('(PDH-CSV')) {
      header = parseDelimitedLine(line)
      break
    }
  }
  if (header === null || header.length < 2) return null
  const headerIndex = lines.findIndex((line) => line.includes('(PDH-CSV'))
  for (const line of lines.slice(headerIndex + 1)) {
    const fields = parseDelimitedLine(line)
    if (fields.length !== header.length) continue
    // Column 0 is the locale-dependent timestamp; a real sample has at least
    // one numeric column after it.
    const numeric = fields.slice(1).some((field) => toFiniteNumber(field) !== null)
    if (numeric) return { header, values: fields }
  }
  return null
}
