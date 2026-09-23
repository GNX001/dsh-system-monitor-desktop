import { readdir, readFile } from 'node:fs/promises'
import { runCommand } from './exec.js'
import { mibToBytes, milliCelsiusToCelsius, readTypeperfFrame, round, toFiniteNumber, usagePercent } from './parse.js'

/**
 * `nvidia-smi --query-gpu=...` field order used by this plugin. `name` is
 * deliberately **last**: GPU marketing names contain commas ("GeForce RTX
 * 4090, Laptop GPU" style suffixes are common), and a trailing free-text column
 * can be re-joined safely whereas a middle one cannot.
 */
export const NVIDIA_QUERY_FIELDS = [
  'index',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
  'name',
]

/**
 * Parse `nvidia-smi --format=csv,noheader,nounits` output.
 * Unsupported counters arrive as `[N/A]` and must stay null.
 * @returns one record per GPU.
 */
export function parseNvidiaSmiCsv(text) {
  const gpus = []
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const fields = line.split(',')
    if (fields.length < NVIDIA_QUERY_FIELDS.length) continue

    const index = toFiniteNumber(fields[0])
    const name = fields.slice(NVIDIA_QUERY_FIELDS.length - 1).join(',').trim()
    const totalBytes = mibToBytes(fields[3])
    const usedBytes = mibToBytes(fields[2])
    gpus.push({
      index: index === null ? gpus.length : index,
      name: name === '' ? 'NVIDIA GPU' : name,
      vendor: 'nvidia',
      source: 'nvidia-smi',
      usage: toFiniteNumber(fields[1]),
      temperature: toFiniteNumber(fields[4]),
      powerWatts: toFiniteNumber(fields[5]),
      memory: {
        usedBytes,
        totalBytes,
        usage: totalBytes !== null && usedBytes !== null ? usagePercent(usedBytes, totalBytes) : null,
      },
    })
  }
  return gpus
}

/** Read every GPU nvidia-smi can see (Windows and Linux). */
export async function readNvidiaGpus(options = {}) {
  const exec = options.exec ?? runCommand
  const command = options.nvidiaSmiPath ?? 'nvidia-smi'
  const result = await exec(
    command,
    [`--query-gpu=${NVIDIA_QUERY_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
    { timeoutMs: options.timeoutMs ?? 3000, platform: options.platform ?? process.platform }
  )
  if (!result.ok) return { gpus: [], error: result.error ?? 'nvidia-smi failed' }
  const gpus = parseNvidiaSmiCsv(result.stdout)
  return gpus.length > 0 ? { gpus, error: null } : { gpus: [], error: 'nvidia-smi reported no devices' }
}

/**
 * Counter paths for the vendor-neutral Windows fallback. `GPU Engine`
 * utilization is published per engine instance (3D, Copy, VideoDecode, …) and
 * per process; `GPU Adapter Memory` reports the adapter's dedicated VRAM in
 * bytes. There is no temperature counter in this set, so the fallback reports
 * utilization and VRAM only.
 */
export const WINDOWS_GPU_COUNTERS = ['\\GPU Engine(*)\\Utilization Percentage', '\\GPU Adapter Memory(*)\\Dedicated Usage']

/** Extract the `luid_0x…_0x…_phys_N` adapter key out of a counter instance. */
export function adapterKeyOf(instance) {
  const match = /luid_0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+_phys_\d+/.exec(instance ?? '')
  return match === null ? null : match[0]
}

/**
 * Aggregate the vendor-neutral Windows GPU counters into one record per
 * adapter.
 *
 * Utilization is the **maximum** across an adapter's engine instances, not the
 * sum: the counters are per-engine percentages, so summing double-counts a
 * frame that is both rendered and copied and can exceed 100%. Max-per-adapter
 * is the same reduction Task Manager performs.
 *
 * @param text - raw `typeperf` stdout.
 * @returns one record per adapter, VRAM total unknowable from this counter set.
 */
export function parseWindowsGpuCounters(text) {
  const frame = readTypeperfFrame(text)
  if (frame === null) return []

  const engines = new Map()
  const dedicated = new Map()
  for (let index = 1; index < frame.header.length; index += 1) {
    const counter = frame.header[index]
    const value = toFiniteNumber(frame.values[index])
    if (value === null) continue

    if (counter.includes('GPU Engine(') && counter.includes('Utilization Percentage')) {
      const key = adapterKeyOf(counter)
      if (key === null) continue
      const current = engines.get(key)
      if (current === undefined || value > current) engines.set(key, value)
      continue
    }
    if (counter.includes('GPU Adapter Memory(') && counter.includes('Dedicated Usage')) {
      const key = adapterKeyOf(counter)
      if (key === null) continue
      dedicated.set(key, value)
    }
  }

  const keys = [...new Set([...engines.keys(), ...dedicated.keys()])].sort()
  return keys.map((key, position) => {
    const usedBytes = dedicated.get(key) ?? null
    return {
      index: position,
      name: `GPU adapter ${key.replace(/^luid_0x[0-9A-Fa-f]+_/, '').replace(/_phys_\d+$/, '')}`,
      vendor: 'unknown',
      source: 'windows-gpu-counters',
      usage: round(engines.get(key) ?? null, 1),
      temperature: null,
      powerWatts: null,
      memory: { usedBytes, totalBytes: null, usage: null },
    }
  })
}

/** Read GPUs through the vendor-neutral Windows performance counters. */
export async function readWindowsGenericGpus(options = {}) {
  const exec = options.exec ?? runCommand
  const result = await exec('typeperf.exe', [...WINDOWS_GPU_COUNTERS, '-sc', '1'], {
    timeoutMs: options.timeoutMs ?? 6000,
    platform: options.platform ?? process.platform,
  })
  if (!result.ok) return { gpus: [], error: result.error ?? 'typeperf failed' }
  const gpus = parseWindowsGpuCounters(result.stdout)
  return gpus.length > 0 ? { gpus, error: null } : { gpus: [], error: 'no GPU performance counters reported' }
}

/**
 * Read AMD GPUs on Linux straight from the amdgpu sysfs nodes — no process, no
 * dependency, full utilization/temperature/VRAM coverage.
 */
export async function readLinuxAmdGpus(options = {}) {
  const fs = options.fs ?? { readdir, readFile }
  const drmRoot = options.drmRoot ?? '/sys/class/drm'
  const gpus = []
  let error = null

  for (const entry of (await safeList(fs, drmRoot)).filter((name) => /^card\d+$/.test(name)).sort()) {
    const device = `${drmRoot}/${entry}/device`
    const usage = toFiniteNumber(await safeRead(fs, `${device}/gpu_busy_percent`))
    const vramUsed = toFiniteNumber(await safeRead(fs, `${device}/mem_info_vram_used`))
    const vramTotal = toFiniteNumber(await safeRead(fs, `${device}/mem_info_vram_total`))
    const temperature = await firstHwmonTemperature(fs, device)

    if (usage === null && vramUsed === null && temperature === null) continue
    gpus.push({
      index: gpus.length,
      name: `${entry} (amdgpu)`,
      vendor: 'amd',
      source: 'linux-sysfs',
      usage: round(usage, 1),
      temperature,
      powerWatts: null,
      memory: {
        usedBytes: vramUsed,
        totalBytes: vramTotal,
        usage: vramTotal !== null && vramUsed !== null ? usagePercent(vramUsed, vramTotal) : null,
      },
    })
  }

  if (gpus.length === 0) error = `no AMD GPU sysfs nodes under ${drmRoot}`
  return { gpus, error }
}

/** First readable `temp*_input` under a device's hwmon children. */
async function firstHwmonTemperature(fs, device) {
  const hwmonRoot = `${device}/hwmon`
  for (const entry of (await safeList(fs, hwmonRoot)).filter((name) => name.startsWith('hwmon')).sort()) {
    const base = `${hwmonRoot}/${entry}`
    // temp1 is the edge/die sensor on amdgpu; fall back to the next ones.
    for (const file of (await safeList(fs, base)).filter((name) => /^temp\d+_input$/.test(name)).sort()) {
      const celsius = milliCelsiusToCelsius(await safeRead(fs, `${base}/${file}`))
      if (celsius !== null) return celsius
    }
  }
  return null
}

/**
 * Collect every GPU on this machine.
 *
 * Order matters: `nvidia-smi` is the only cross-platform source that carries
 * temperature and power, so it wins whenever it answers. Only when it is absent
 * or silent does the platform fallback run.
 *
 * @returns `{ gpus, source, errors }`.
 */
export async function sampleGpus(options = {}) {
  const platform = options.platform ?? process.platform
  const errors = []

  try {
    const nvidia = await readNvidiaGpus(options)
    if (nvidia.gpus.length > 0) return { gpus: nvidia.gpus, source: 'nvidia-smi', errors }
    if (nvidia.error !== null) errors.push(nvidia.error)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  try {
    if (platform === 'win32') {
      const generic = await readWindowsGenericGpus(options)
      if (generic.error !== null) errors.push(generic.error)
      return { gpus: generic.gpus, source: generic.gpus.length > 0 ? 'windows-gpu-counters' : 'none', errors }
    }
    if (platform === 'linux') {
      const amd = await readLinuxAmdGpus(options)
      if (amd.error !== null) errors.push(amd.error)
      return { gpus: amd.gpus, source: amd.gpus.length > 0 ? 'linux-sysfs' : 'none', errors }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  return { gpus: [], source: 'none', errors }
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
