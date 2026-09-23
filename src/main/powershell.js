/**
 * Run a PowerShell script and parse one JSON object back.
 *
 * The scripts are handed to `powershell.exe` as `-EncodedCommand` (base64
 * UTF-16LE), which avoids every layer of shell quoting between here and the
 * Windows API — and the text is JSON on the last line, so a stray progress or
 * warning line on stdout cannot break the parse.
 */
import { execFile } from 'node:child_process'

const POWERSHELL = 'powershell.exe'

/** @returns `{ value }` with the parsed object, or `{ error }`. */
export function runPowerShell(body, { timeoutMs = 20000 } = {}) {
  const encoded = Buffer.from(body, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ error: error.message, stderr: String(stderr).slice(0, 400) })
          return
        }
        const line = String(stdout)
          .trim()
          .split('\n')
          .filter((entry) => entry.trim() !== '')
          .pop()
        if (line === undefined) {
          resolve({ error: 'no output' })
          return
        }
        try {
          resolve({ value: JSON.parse(line) })
        } catch {
          resolve({ error: 'unparsable output', raw: line.slice(0, 300) })
        }
      },
    )
  })
}

/** Single-quote a value for a PowerShell literal. */
export function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
