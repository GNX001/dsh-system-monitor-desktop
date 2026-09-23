/**
 * Record / verify the vendored files.
 *
 * The app carries copies of the plugin's collectors and view model so it stands
 * alone. Copies drift silently, so this pins them twice: `vendored.json` holds
 * the sha256 of every copied file (asserted by `test/app.test.mjs`, which works
 * with no checkout present), and running with a plugin checkout available also
 * checks the copies against the source they claim to come from.
 *
 *   node tools/verify-vendor.mjs            # verify against vendored.json (+ source, if present)
 *   node tools/verify-vendor.mjs --write    # refresh vendored.json from the current copies
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const recordFile = join(root, 'tools', 'vendored.json')
const write = process.argv.includes('--write')

/** Every file copied out of `dsh-system-monitor`, and where it came from there. */
export const VENDORED = {
  'metrics/parse.js': 'lib/metrics/parse.js',
  'metrics/exec.js': 'lib/metrics/exec.js',
  'metrics/cpu.js': 'lib/metrics/cpu.js',
  'metrics/memory.js': 'lib/metrics/memory.js',
  'metrics/cputemp.js': 'lib/metrics/cputemp.js',
  'metrics/gpu.js': 'lib/metrics/gpu.js',
  'metrics/network.js': 'lib/metrics/network.js',
  'metrics/monitor.js': 'lib/metrics/monitor.js',
  'model.js': 'src/client/model.js',
  'locales.js': 'src/client/locales.js',
}

const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')

if (write) {
  const record = {}
  for (const local of Object.keys(VENDORED)) {
    record[local] = await sha256(join(root, 'src', 'shared', local))
  }
  await writeFile(recordFile, `${JSON.stringify(record, undefined, 2)}\n`, 'utf8')
  console.log(`[vendor] recorded ${Object.keys(record).length} files in ${recordFile}`)
} else {
  const record = JSON.parse(await readFile(recordFile, 'utf8'))
  let failures = 0
  for (const [local, expected] of Object.entries(record)) {
    const actual = await sha256(join(root, 'src', 'shared', local))
    if (actual !== expected) {
      console.error(`[vendor] MISMATCH ${local}`)
      failures += 1
    }
  }
  console.log(`[vendor] ${Object.keys(record).length - failures}/${Object.keys(record).length} copies match the record`)

  const sourceDir = process.env.DSM_PLUGIN_DIR ?? resolve(root, '..', 'dsh-system-monitor')
  if (existsSync(sourceDir)) {
    let sourceFailures = 0
    for (const [local, remote] of Object.entries(VENDORED)) {
      const source = join(sourceDir, remote)
      if (!existsSync(source)) {
        console.error(`[vendor] source missing ${remote}`)
        sourceFailures += 1
        continue
      }
      if ((await sha256(source)) !== (await sha256(join(root, 'src', 'shared', local)))) {
        console.error(`[vendor] DRIFT ${local} != ${remote}`)
        sourceFailures += 1
      }
    }
    console.log(
      sourceFailures === 0
        ? `[vendor] identical to ${sourceDir}`
        : `[vendor] ${sourceFailures} file(s) drifted from ${sourceDir}`
    )
    failures += sourceFailures
  } else {
    console.log(`[vendor] no plugin checkout at ${sourceDir} — checked the record only`)
  }

  process.exitCode = failures === 0 ? 0 : 1
}
