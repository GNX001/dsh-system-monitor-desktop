import { cpus as osCpus } from 'node:os'
import { clamp01, round } from './parse.js'

/**
 * Stateful CPU-usage sampler.
 *
 * `/proc`-free by design: `os.cpus()` reports cumulative per-core jiffies on
 * every platform Node supports, so usage is the idle/total delta between two
 * consecutive calls. The first call therefore has no rate to report and returns
 * `usage: null`; the sampler is called on every tick, so that only affects the
 * very first snapshot after boot.
 *
 * @param options - injectable `cpus` reader for tests.
 * @returns a function returning `{ usage, perCore, cores, model, speedMHz }`
 *   with percentages in 0..100.
 */
export function createCpuUsageSampler(options = {}) {
  const readCpus = options.cpus ?? osCpus
  let previous = null

  return function sampleCpu() {
    const list = readCpus() ?? []
    const current = list.map((cpu) => {
      const times = cpu?.times ?? {}
      const total =
        (times.user ?? 0) + (times.nice ?? 0) + (times.sys ?? 0) + (times.idle ?? 0) + (times.irq ?? 0)
      return { idle: times.idle ?? 0, total }
    })

    let usage = null
    let perCore = []
    if (previous !== null && current.length > 0 && current.length === previous.length) {
      let idleDelta = 0
      let totalDelta = 0
      perCore = current.map((core, index) => {
        const idle = core.idle - previous[index].idle
        const total = core.total - previous[index].total
        idleDelta += idle
        totalDelta += total
        return total > 0 ? round(clamp01(1 - idle / total) * 100, 1) : null
      })
      if (totalDelta > 0) usage = round(clamp01(1 - idleDelta / totalDelta) * 100, 1)
    }

    previous = current
    return {
      usage,
      perCore,
      cores: current.length,
      model: list[0]?.model ?? null,
      speedMHz: list[0]?.speed ?? null,
    }
  }
}
