import { freemem as osFreemem, totalmem as osTotalmem } from 'node:os'
import { clamp01, round } from './parse.js'

/**
 * Read physical memory pressure.
 *
 * `os.freemem()` maps to libuv's "available" figure on Windows
 * (`GlobalMemoryStatusEx.ullAvailPhys`) and to `MemAvailable`-equivalent
 * accounting elsewhere, which is the number Task Manager / Activity Monitor
 * label "available" — so `used = total - available` matches what users expect,
 * unlike raw "free" memory which double-counts page cache as used.
 *
 * @param options - injectable readers for tests.
 * @returns `{ totalBytes, freeBytes, usedBytes, usage }` with `usage` in 0..100.
 */
export function sampleMemory(options = {}) {
  const readTotal = options.totalmem ?? osTotalmem
  const readFree = options.freemem ?? osFreemem

  const total = Number(readTotal()) || 0
  const free = Number(readFree()) || 0
  const used = Math.max(0, total - free)

  return {
    totalBytes: total,
    freeBytes: Math.min(free, total),
    usedBytes: used,
    usage: total > 0 ? round(clamp01(used / total) * 100, 1) : null,
  }
}
