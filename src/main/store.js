import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Tiny JSON-file store: read that never throws, write that cannot half-land.
 *
 * A widget has no UI in which to report "your settings file is corrupt", so a
 * failed read degrades to the fallback and the next write repairs the file.
 */

/**
 * Read and parse a JSON file.
 * @param file - absolute path.
 * @param fallback - returned for a missing file, invalid JSON, or an IO error.
 */
export async function readJson(file, fallback) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Write a JSON file atomically (temp file + rename), so a crash mid-write leaves
 * the previous settings intact rather than a truncated file.
 * @returns true when the write landed.
 */
export async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
    await rename(temporary, file)
    return true
  } catch {
    return false
  }
}
