/**
 * The sign-in entry, managed through the Run key.
 *
 * Electron's own `app.setLoginItemSettings` writes the entry, but it writes the
 * executable path **unquoted** — verified on Electron 33 by reading the key back:
 * a build sitting in `...\_pkg dir with spaces\...exe` produced exactly that
 * unquoted command line. Windows parses a Run value as a command line, so an
 * unquoted path with spaces is read as the program `...\_pkg`. This is a portable
 * app that a user may well unpack anywhere, so the entry is written here instead,
 * quoted, and read back by the same code that wrote it.
 *
 * Its `getLoginItemSettings` read side is no better for this purpose: on Windows
 * it reports `openAtLogin: false` for an entry it has just created, exposing the
 * truth only in `launchItems` / `executableWillLaunchAtLogin`.
 */
import { psQuote, runPowerShell } from './powershell.js'

const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** Every Run entry as `{ name: value }`, or `{ error }`. */
export async function readRunKey() {
  const script = `
$path = ${psQuote(RUN_KEY)}
$out = [ordered]@{}
if (Test-Path $path) {
  $key = Get-ItemProperty -Path $path
  foreach ($p in $key.PSObject.Properties) {
    if ($p.Name -notlike 'PS*') { $out[$p.Name] = [string]$p.Value }
  }
}
@{ 'entries' = $out } | ConvertTo-Json -Compress -Depth 4
`
  const result = await runPowerShell(script)
  if (result.error !== undefined) return { error: result.error }
  return { entries: result.value?.entries ?? {} }
}

/** The command line stored for `name`, or `null` when it is absent. */
export async function readLoginItem(name) {
  const key = await readRunKey()
  if (key.error !== undefined) return { error: key.error }
  const value = key.entries?.[name]
  return { value: typeof value === 'string' ? value : null }
}

/**
 * Register `exePath` to run at sign-in, **quoted**.
 *
 * Written as `"C:\dir with spaces\app.exe"` so Windows reads one program and no
 * arguments — the form the Run key is documented to take.
 */
export async function writeLoginItem(name, exePath) {
  const script = `
$path = ${psQuote(RUN_KEY)}
New-Item -Path $path -Force | Out-Null
Set-ItemProperty -Path $path -Name ${psQuote(name)} -Value ${psQuote(`"${exePath}"`)} -Type String
@{ 'ok' = $true } | ConvertTo-Json -Compress
`
  const result = await runPowerShell(script)
  return result.error === undefined ? { ok: true } : { error: result.error }
}

/** Remove the entry for `name`; absent is success. */
export async function clearLoginItem(name) {
  const script = `
$path = ${psQuote(RUN_KEY)}
if (Test-Path $path) {
  Remove-ItemProperty -Path $path -Name ${psQuote(name)} -ErrorAction SilentlyContinue
}
@{ 'ok' = $true } | ConvertTo-Json -Compress
`
  const result = await runPowerShell(script)
  return result.error === undefined ? { ok: true } : { error: result.error }
}
