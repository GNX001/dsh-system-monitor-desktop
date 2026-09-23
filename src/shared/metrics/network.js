import { readFile } from 'node:fs/promises'
import { runCommand } from './exec.js'
import { readTypeperfFrame, toFiniteNumber } from './parse.js'

/**
 * Network throughput, both directions.
 *
 * There is no Node API for interface counters, so this follows the same rule as
 * the rest of the plugin: use what the operating system already publishes, and
 * report `null` rather than guessing when it publishes nothing.
 *
 * - **Windows** — the PDH counters `\Network Interface(*)\Bytes Received/sec`
 *   and `\Bytes Sent/sec` are already *rates*, so they need no differencing; one
 *   `typeperf` run returns a one-second average per adapter.
 * - **Linux** — `/proc/net/dev` holds *cumulative* byte counts, so this module
 *   keeps the previous sample and divides the delta by the elapsed time.
 * - **macOS** — no non-root source; reported as unsupported with a reason.
 *
 * Both platforms therefore surface the same shape: bytes per second, or null.
 */

/**
 * Adapter name fragments that must not be counted.
 *
 * Summing every PDH `Network Interface` instance double-counts: a loopback or
 * VPN/overlay adapter carries the *same* packets as the physical one, and
 * Windows also lists a duplicate instance (suffixed `_2`) whenever two adapters
 * share a name. Counting those would inflate the readout — a local dev server
 * alone can produce gigabytes of loopback traffic — so the filter is explicit
 * and overridable through `networkExclude`.
 */
export const DEFAULT_EXCLUDED_INTERFACES = [
  'loopback',
  'pseudo',
  'virtual',
  'isatap',
  'teredo',
  'vmware',
  'vmnet',
  'virtualbox',
  'hyper-v',
  'vethernet',
  'wsl',
  'bluetooth',
  'tap-windows',
  'wintun',
  'wireguard',
  'openvpn',
  'npcap',
  'docker',
  'br-',
  'veth',
  'virbr',
  'tailscale',
  'zerotier',
  'tun',
  'tap',
]

const WINDOWS_COUNTERS = ['\\Network Interface(*)\\Bytes Received/sec', '\\Network Interface(*)\\Bytes Sent/sec']

/** The two counter names, matched out of a `typeperf` header path. */
const RECEIVED = 'Bytes Received/sec'
const SENT = 'Bytes Sent/sec'

/**
 * Build the predicate that decides whether an adapter contributes to the total.
 * @param exclude - extra fragments; defaults to {@link DEFAULT_EXCLUDED_INTERFACES}.
 * @param include - fragments that force inclusion even if a default matched.
 */
export function createInterfaceFilter(exclude, include = []) {
  const deny = (exclude ?? DEFAULT_EXCLUDED_INTERFACES).map((value) => String(value).toLowerCase())
  const allow = include.map((value) => String(value).toLowerCase())
  return (name) => {
    const lower = String(name).toLowerCase()
    if (allow.some((fragment) => lower.includes(fragment))) return true
    // `lo` is the Linux loopback device, unmatched by the word "loopback".
    if (lower === 'lo') return false
    // A duplicated Windows instance is suffixed `_2`, `_3`, …
    if (/_\d+$/.test(lower)) return false
    return !deny.some((fragment) => lower.includes(fragment))
  }
}

/**
 * Parse one `typeperf` run of the two network counters.
 *
 * Columns are counter-major (every Received instance, then every Sent one), so
 * the counter name is read from each header path rather than assumed from the
 * column position.
 *
 * @param text - raw `typeperf` stdout.
 * @param options.exclude / options.include - adapter filters.
 * @returns `{ ok, downloadBytesPerSec, uploadBytesPerSec, interfaces, error }`.
 */
export function parseWindowsNetworkCounters(text, options = {}) {
  const frame = readTypeperfFrame(text)
  if (frame === null) {
    return failure('no readable typeperf frame in the output')
  }

  const counted = createInterfaceFilter(options.exclude, options.include)
  const byName = new Map()
  for (let index = 1; index < frame.header.length; index += 1) {
    const match = /Network Interface\((.*)\)\\(Bytes (?:Received|Sent)\/sec)/.exec(frame.header[index] ?? '')
    if (match === null) continue
    const [, name, counter] = match
    const value = toFiniteNumber(frame.values[index])
    if (value === null) continue

    const entry = byName.get(name) ?? {
      name,
      counted: counted(name),
      downloadBytesPerSec: 0,
      uploadBytesPerSec: 0,
    }
    if (counter === RECEIVED) entry.downloadBytesPerSec += value
    else entry.uploadBytesPerSec += value
    byName.set(name, entry)
  }

  const interfaces = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  if (interfaces.length === 0) return failure('typeperf reported no Network Interface instances')

  let download = 0
  let upload = 0
  for (const entry of interfaces) {
    if (!entry.counted) continue
    download += entry.downloadBytesPerSec
    upload += entry.uploadBytesPerSec
  }
  return {
    ok: true,
    downloadBytesPerSec: Math.max(0, download),
    uploadBytesPerSec: Math.max(0, upload),
    interfaces,
    error: null,
  }
}

/** Read Windows throughput through the PDH rate counters. */
export async function readWindowsNetwork(options = {}) {
  const exec = options.exec ?? runCommand
  const result = await exec('typeperf.exe', [...WINDOWS_COUNTERS, '-sc', '1'], {
    timeoutMs: options.timeoutMs ?? 4000,
    platform: options.platform ?? process.platform,
  })
  if (!result.ok) {
    return { ...failure(result.error ?? 'typeperf failed'), source: 'windows-network-counters' }
  }
  return { ...parseWindowsNetworkCounters(result.stdout, options), source: 'windows-network-counters' }
}

/**
 * Parse `/proc/net/dev` into cumulative per-interface byte counts.
 *
 * The file is two header lines followed by one line per interface; the byte
 * counters are the first field after the colon (received) and the ninth (sent).
 *
 * @returns one record per interface, or [] when nothing parses.
 */
export function parseProcNetDev(text) {
  const interfaces = []
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const colon = rawLine.indexOf(':')
    if (colon < 0) continue
    const name = rawLine.slice(0, colon).trim()
    if (name === '' || name.includes('|') || name.includes('face')) continue
    const fields = rawLine
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map((field) => toFiniteNumber(field))
    if (fields.length < 9) continue
    const [rxBytes] = fields
    const txBytes = fields[8]
    if (rxBytes === null || txBytes === null) continue
    interfaces.push({ name, rxBytes, txBytes })
  }
  return interfaces
}

/**
 * Build a stateful Linux throughput sampler: `/proc/net/dev` is cumulative, so
 * each call reports the delta since the previous one divided by the elapsed
 * time. The first call has no baseline and reports null, mirroring the CPU
 * sampler.
 */
export function createLinuxNetworkSampler(options = {}) {
  const read = options.readFile ?? ((path) => readFile(path, 'utf8'))
  const clock = options.now ?? (() => Date.now())
  const counted = createInterfaceFilter(options.exclude, options.include)
  const path = options.path ?? '/proc/net/dev'
  let previous = null

  return async function sample() {
    let text
    try {
      text = await read(path)
    } catch (error) {
      return { ...failure(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`), source: 'proc-net-dev' }
    }
    const at = clock()
    const parsed = parseProcNetDev(text)
    if (parsed.length === 0) return { ...failure(`no interfaces in ${path}`), source: 'proc-net-dev' }

    const interfaces = parsed.map((entry) => ({ ...entry, counted: counted(entry.name) }))
    let rx = 0
    let tx = 0
    for (const entry of interfaces) {
      if (!entry.counted) continue
      rx += entry.rxBytes
      tx += entry.txBytes
    }

    const baseline = previous
    previous = { at, rx, tx }
    if (baseline === null) {
      return {
        ok: true,
        downloadBytesPerSec: null,
        uploadBytesPerSec: null,
        interfaces,
        error: null,
        pending: 'first sample: no interval to measure yet',
        source: 'proc-net-dev',
      }
    }

    const seconds = (at - baseline.at) / 1000
    if (!(seconds > 0)) {
      return { ok: true, downloadBytesPerSec: null, uploadBytesPerSec: null, interfaces, error: null, source: 'proc-net-dev' }
    }
    return {
      ok: true,
      downloadBytesPerSec: Math.max(0, (rx - baseline.rx) / seconds),
      uploadBytesPerSec: Math.max(0, (tx - baseline.tx) / seconds),
      interfaces,
      error: null,
      source: 'proc-net-dev',
    }
  }
}

/**
 * Platform dispatch for network throughput.
 * @returns `{ downloadBytesPerSec, uploadBytesPerSec, interfaces, source, error }`.
 *   Both rates are null (never 0) when the platform cannot measure them.
 */
export async function sampleNetwork(options = {}) {
  const platform = options.platform ?? process.platform
  try {
    if (platform === 'win32') return await readWindowsNetwork(options)
    if (platform === 'linux') {
      const sampler = options.linuxSampler ?? createLinuxNetworkSampler(options)
      return await sampler()
    }
    return {
      ...failure(`network throughput is not available on ${platform} without extra tooling`),
      source: 'unsupported',
    }
  } catch (error) {
    return {
      ...failure(error instanceof Error ? error.message : String(error)),
      source: 'error',
    }
  }
}

/** The null result every failure path returns. */
function failure(message) {
  return {
    ok: false,
    downloadBytesPerSec: null,
    uploadBytesPerSec: null,
    interfaces: [],
    error: message,
  }
}
