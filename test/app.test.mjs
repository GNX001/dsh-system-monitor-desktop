import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULT_OPTIONS, buildViewModel } from '../src/shared/model.js'
import { bindDictionary, en, zh } from '../src/shared/locales.js'
import { DEFAULT_CADENCE, createMonitor } from '../src/shared/metrics/monitor.js'

/**
 * The app carries vendored copies of the DeepSeek Harness plugin's collectors
 * and view model. These tests pin the contract the app depends on, so a
 * re-vendor that breaks it fails here rather than in the window.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the vendored view model still renders the app\'s rows', () => {
  const snapshot = {
    ts: Date.now(),
    host: { hostname: 'dev-box', platform: 'win32' },
    cpu: { usage: 23.4, cores: 32, model: 'AMD Ryzen 9 8940HX', temperature: 79.9, perCore: [] },
    memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 13.4 * 1024 ** 3, usage: 43 },
    gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU', usage: 0, temperature: 51, memory: { usedBytes: 0, totalBytes: 12 * 1024 ** 3 } }],
    network: {
      downloadBytesPerSec: 1.25 * 1024 ** 2,
      uploadBytesPerSec: 240 * 1024,
      source: 'windows-network-counters',
      interfaces: [{ name: 'Wi-Fi', counted: true }],
    },
    errors: [],
  }

  const view = buildViewModel(snapshot, DEFAULT_OPTIONS)
  assert.equal(view.ok, true)
  assert.deepEqual(
    view.rows.map((row) => row.labelKey),
    ['labelCpu', 'labelMem', 'labelGpu', 'labelNet']
  )
  assert.equal(view.rows[0].valueText, '23%')
  assert.deepEqual(view.rows[1].details.map((detail) => detail.text), ['13.4/32.0 GB'])
  assert.deepEqual(view.rows[2].details.map((detail) => detail.text), ['51°C', '0/12.0 GB'])
  assert.equal(view.rows[3].valueText, '↓ 1.3 MB/s')
})

test('the app renders the network item in Chinese as 网速', () => {
  const view = buildViewModel(
    {
      ts: Date.now(),
      cpu: { usage: 1 },
      memory: { usage: 2 },
      gpus: [],
      network: { downloadBytesPerSec: 0, uploadBytesPerSec: 0, interfaces: [] },
      errors: [],
    },
    DEFAULT_OPTIONS
  )
  const network = view.rows.at(-1)
  assert.equal(bindDictionary(zh)(network.labelKey, network.labelParams), '网速')
  assert.equal(bindDictionary(en)(network.labelKey, network.labelParams), 'NET')
  assert.equal(network.valueText, '↓ 0 B/s')
})

test('the vendored monitor still reports the shape the app reads', async () => {
  const monitor = createMonitor({ platform: 'win32', gpu: false, cpuTemperature: false, network: false, tickMs: 60_000 })
  const snapshot = await monitor.refresh()
  monitor.stop()

  assert.ok(Number.isFinite(snapshot.ts) && snapshot.ts > 0)
  assert.equal(typeof snapshot.host.hostname, 'string')
  assert.ok('usage' in snapshot.cpu && 'temperature' in snapshot.cpu)
  assert.ok('usedBytes' in snapshot.memory && 'totalBytes' in snapshot.memory)
  assert.ok(Array.isArray(snapshot.gpus))
  assert.ok('downloadBytesPerSec' in snapshot.network && 'uploadBytesPerSec' in snapshot.network)
  assert.ok(Array.isArray(snapshot.errors))
  assert.equal(snapshot.cpu.usage, null, 'one reading is not a rate')
  assert.ok(DEFAULT_CADENCE.networkMs > 0)
})

test('the collectors are byte-identical to the plugin release they came from', async () => {
  // A re-vendor must be deliberate; this records which files were copied. The
  // hashes live in tools/vendored.json and are refreshed by tools/verify-vendor.mjs
  // against a checkout of dsh-system-monitor.
  const record = JSON.parse(await readFile(join(root, 'tools', 'vendored.json'), 'utf8'))
  const { createHash } = await import('node:crypto')
  for (const [name, expected] of Object.entries(record)) {
    const bytes = await readFile(join(root, 'src', 'shared', name))
    const actual = createHash('sha256').update(bytes).digest('hex')
    assert.equal(actual, expected, `${name} differs from the recorded vendored revision`)
  }
})
