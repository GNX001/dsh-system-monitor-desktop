import { arch, hostname, platform as osPlatform, uptime } from 'node:os'
import { createCpuUsageSampler } from './cpu.js'
import { sampleCpuTemperature } from './cputemp.js'
import { sampleGpus } from './gpu.js'
import { sampleMemory } from './memory.js'
import { sampleNetwork } from './network.js'

/**
 * Sampling cadences, in milliseconds.
 *
 * CPU usage, memory and the CPU rate counters are computed in-process from data
 * Node already maintains, so they refresh on every tick. Every other probe
 * spawns a short-lived helper process (`nvidia-smi`, `typeperf`), so it runs on
 * a slower cadence and its last value is carried between refreshes — the tile
 * therefore never blocks on hardware.
 */
export const DEFAULT_CADENCE = {
  tickMs: 1000,
  gpuMs: 1500,
  cpuTemperatureMs: 5000,
  networkMs: 3000,
}

/** Bounded length of the per-snapshot diagnostics list. */
const MAX_ERRORS = 6

/**
 * Build the background sampler behind `GET /api/dsh-system-monitor/snapshot`.
 *
 * The routes are polled by the tile, so the HTTP handler must never do IO: it
 * reads a cached snapshot that a timer keeps warm. `refresh()` exists for the
 * tile's manual refresh button.
 *
 * @param options - cadence and injectable seams (`exec`, `now`, `platform`,
 *   `fs`, timer functions, and the individual `sample*` functions) used by tests.
 * @returns `{ start, stop, snapshot, refresh, config }`.
 */
export function createMonitor(options = {}) {
  const cadence = {
    tickMs: options.tickMs ?? DEFAULT_CADENCE.tickMs,
    gpuMs: options.gpuMs ?? DEFAULT_CADENCE.gpuMs,
    // `cpuTemperatureMs` is the pre-0.3 name; honour it so an existing profile
    // config keeps working.
    cpuTemperatureMs: options.cpuTemperatureMs ?? options.countersMs ?? DEFAULT_CADENCE.cpuTemperatureMs,
    networkMs: options.networkMs ?? DEFAULT_CADENCE.networkMs,
  }
  const platform = options.platform ?? osPlatform()
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? setInterval
  const clearTimer = options.clearTimer ?? clearInterval
  const collectCpu = options.collectCpu ?? createCpuUsageSampler()
  const collectMemory = options.collectMemory ?? (() => sampleMemory())
  const collectGpus = options.collectGpus ?? ((seams) => sampleGpus(seams))
  const collectCpuTemperature = options.collectCpuTemperature ?? ((seams) => sampleCpuTemperature(seams))
  const collectNetwork = options.collectNetwork ?? ((seams) => sampleNetwork(seams))

  const gpuEnabled = options.gpu !== false
  const cpuTemperatureEnabled = options.cpuTemperature !== false
  const networkEnabled = options.network !== false
  const seams = {
    exec: options.exec,
    fs: options.fs,
    platform,
    scale: options.cpuTemperatureScale ?? 'auto',
    nvidiaSmiPath: options.nvidiaSmiPath,
    timeoutMs: options.probeTimeoutMs,
    exclude: options.networkExclude,
    include: options.networkInclude,
    linuxSampler: options.linuxNetworkSampler,
  }

  const state = {
    ts: 0,
    startedAt: now(),
    host: {
      hostname: hostname(),
      platform,
      arch: arch(),
      uptimeSec: Math.round(uptime()),
      pid: process.pid,
    },
    cpu: { usage: null, perCore: [], cores: 0, model: null, speedMHz: null, temperature: null, temperatureSource: null, temperatureZones: [] },
    memory: { totalBytes: 0, freeBytes: 0, usedBytes: 0, usage: null },
    gpus: [],
    gpuSource: 'none',
    network: { downloadBytesPerSec: null, uploadBytesPerSec: null, source: null, interfaces: [] },
    errors: [],
    ticks: 0,
  }

  let timer = null
  let inFlight = null
  let lastGpuAt = 0
  let lastCpuTemperatureAt = 0
  let lastNetworkAt = 0

  /** Cancel the sampling timer, if any. */
  function stop() {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  /** One sampling tick; concurrent callers share the in-flight promise. */
  function tick(force) {
    if (inFlight !== null) return inFlight
    inFlight = (async () => {
      const at = now()
      const errors = []

      try {
        const cpu = collectCpu()
        state.cpu = { ...state.cpu, ...cpu }
      } catch (error) {
        errors.push({ source: 'cpu', message: messageOf(error) })
      }

      try {
        state.memory = collectMemory()
      } catch (error) {
        errors.push({ source: 'memory', message: messageOf(error) })
      }

      const pending = []

      if (gpuEnabled && (force === true || at - lastGpuAt >= cadence.gpuMs)) {
        lastGpuAt = at
        pending.push(
          Promise.resolve()
            .then(() => collectGpus(seams))
            .then((result) => {
              state.gpus = Array.isArray(result?.gpus) ? result.gpus : []
              state.gpuSource = result?.source ?? 'none'
              for (const message of result?.errors ?? []) errors.push({ source: 'gpu', message })
            })
            .catch((error) => errors.push({ source: 'gpu', message: messageOf(error) }))
        )
      }

      if (cpuTemperatureEnabled && (force === true || at - lastCpuTemperatureAt >= cadence.cpuTemperatureMs)) {
        lastCpuTemperatureAt = at
        pending.push(
          Promise.resolve()
            .then(() => collectCpuTemperature(seams))
            .then((result) => {
              state.cpu.temperature = result?.celsius ?? null
              state.cpu.temperatureSource = result?.source ?? null
              state.cpu.temperatureZones = result?.zones ?? []
              if (state.cpu.temperature === null && typeof result?.error === 'string') {
                errors.push({ source: 'cpu-temperature', message: result.error })
              }
            })
            .catch((error) => errors.push({ source: 'cpu-temperature', message: messageOf(error) }))
        )
      }

      if (networkEnabled && (force === true || at - lastNetworkAt >= cadence.networkMs)) {
        lastNetworkAt = at
        pending.push(
          Promise.resolve()
            .then(() => collectNetwork(seams))
            .then((result) => {
              state.network = {
                downloadBytesPerSec: result?.downloadBytesPerSec ?? null,
                uploadBytesPerSec: result?.uploadBytesPerSec ?? null,
                source: result?.source ?? null,
                interfaces: Array.isArray(result?.interfaces) ? result.interfaces : [],
              }
              // A first Linux sample legitimately has no interval yet; that is
              // not a failure, so only a real error is reported.
              if (result?.ok === false && typeof result?.error === 'string') {
                errors.push({ source: 'network', message: result.error })
              }
            })
            .catch((error) => errors.push({ source: 'network', message: messageOf(error) }))
        )
      }

      if (pending.length > 0) await Promise.all(pending)

      state.errors = errors.slice(0, MAX_ERRORS)
      state.ts = now()
      state.ticks += 1
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    /** Sampling cadences plus the resolved enable switches. */
    get config() {
      return { ...cadence, gpu: gpuEnabled, cpuTemperature: cpuTemperatureEnabled, network: networkEnabled }
    },

    /** Start the timer; returns the disposer that stops it. */
    start() {
      if (timer !== null) return () => {}
      void tick(true)
      timer = setTimer(() => void tick(false), cadence.tickMs)
      timer?.unref?.()
      return () => stop()
    },

    /** Stop sampling. */
    stop() {
      stop()
    },

    /** Current cached snapshot (a structured clone, safe to serialize). */
    snapshot() {
      return JSON.parse(JSON.stringify(state))
    },

    /** Force a full refresh and wait for it — the tile's manual refresh. */
    async refresh() {
      if (inFlight !== null) await inFlight
      await tick(true)
      return this.snapshot()
    },
  }
}

/** Normalize a thrown value to a short message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
