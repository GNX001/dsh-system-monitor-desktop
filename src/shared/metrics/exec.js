import { spawn as nodeSpawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_BYTES = 512 * 1024

/**
 * Run one short-lived external probe (`nvidia-smi`, `typeperf`, `rocm-smi`) and
 * collect its output.
 *
 * Every failure mode resolves to a result object instead of rejecting: a missing
 * GPU tool or a hostile environment must degrade a single metric, never take
 * down the sampler tick.
 *
 * Two transports are used, in order:
 *
 * 1. **Anonymous pipes** — the normal path everywhere.
 * 2. **Temp-file redirection** — Windows-only retry for hosts running under a
 *    restricted token, where creating the pipes for `stdio: 'pipe'` fails with
 *    `EPERM`. The probe is re-run through `cmd.exe /c` with `stdio: 'ignore'`
 *    and its output redirected into a private temp file, which is then read and
 *    deleted. Slower, but it keeps hardware readings alive where the pipe
 *    transport is unavailable.
 *
 * @param command - executable name or path.
 * @param args - argument vector (never shell-interpreted on the pipe path).
 * @param options - `timeoutMs`, `maxBytes`, `platform`, and the injectable
 *   `spawnImpl`/`tempDir` seams used by tests.
 * @returns `{ ok, code, stdout, stderr, error, timedOut, transport }`.
 */
export async function runCommand(command, args, options = {}) {
  const piped = await runPiped(command, args, options)
  if (piped.ok || !shouldRetryThroughFile(piped, options)) return piped
  const viaFile = await runViaTempFile(command, args, options)
  return viaFile.ok ? viaFile : piped
}

/**
 * Whether a failed pipe attempt should be retried through a temp file: only the
 * Windows restricted-token `EPERM`/`EACCES` spawn refusal, and only when the
 * failure happened before any output arrived.
 */
function shouldRetryThroughFile(result, options) {
  if (options.disableFileFallback === true) return false
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return false
  if (result.timedOut) return false
  if (result.stdout !== '' || result.stderr !== '') return false
  return /^(EPERM|EACCES):/.test(result.error ?? '')
}

/** Pipe-transport implementation. */
function runPiped(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const spawnImpl = options.spawnImpl ?? nodeSpawn

  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child = null

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ transport: 'pipe', ...result })
    }

    const timer = setTimeout(() => {
      killQuietly(child)
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: `${command} timed out after ${timeoutMs}ms`,
        timedOut: true,
      })
    }, timeoutMs)

    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      finish({ ok: false, code: null, stdout, stderr, error: describeError(error), timedOut: false })
      return
    }

    child.on('error', (error) => {
      finish({ ok: false, code: null, stdout, stderr, error: describeError(error), timedOut: false })
    })

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (stdout.length > maxBytes) {
          stdout = stdout.slice(0, maxBytes)
          killQuietly(child)
          finish({
            ok: false,
            code: null,
            stdout,
            stderr,
            error: `${command} produced more than ${maxBytes} bytes`,
            timedOut: false,
          })
        }
      })
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        if (stderr.length < maxBytes) stderr += chunk
      })
    }

    child.on('close', (code, signal) => {
      finish({
        ok: code === 0,
        code: code ?? null,
        signal: signal ?? null,
        stdout,
        stderr,
        error: code === 0 ? null : `${command} exited with code ${code}${signal ? ` (${signal})` : ''}`,
        timedOut: false,
      })
    })
  })
}

/** Temp-file transport: only reached on the Windows restricted-token path. */
async function runViaTempFile(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const spawnImpl = options.spawnImpl ?? nodeSpawn
  const tempDir = options.tempDir ?? tmpdir()
  const outFile = join(tempDir, `dsh-system-monitor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)

  try {
    const line = `${quoteForCmd(command)} ${args.map(quoteForCmd).join(' ')} > ${quoteForCmd(outFile)} 2>&1`
    const child = spawnImpl('cmd.exe', ['/d', '/c', line], { stdio: 'ignore', windowsHide: true })
    const code = await waitForExit(child, timeoutMs)
    if (code === null) {
      killQuietly(child)
      return { ok: false, code: null, stdout: '', stderr: '', error: `${command} timed out after ${timeoutMs}ms`, timedOut: true, transport: 'file' }
    }
    let stdout = ''
    try {
      stdout = await readFile(outFile, 'utf8')
    } catch (error) {
      return { ok: false, code, stdout: '', stderr: '', error: describeError(error), timedOut: false, transport: 'file' }
    }
    if (stdout.length > maxBytes) stdout = stdout.slice(0, maxBytes)
    return {
      ok: code === 0,
      code,
      stdout,
      stderr: '',
      error: code === 0 ? null : `${command} exited with code ${code}`,
      timedOut: false,
      transport: 'file',
    }
  } catch (error) {
    return { ok: false, code: null, stdout: '', stderr: '', error: describeError(error), timedOut: false, transport: 'file' }
  } finally {
    await unlink(outFile).catch(() => undefined)
  }
}

/** Resolve the child's exit code, or null on timeout. */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    child.on('error', () => done(null))
    child.on('close', (code) => done(code ?? 0))
  })
}

/** Quote one argv element for the `cmd.exe` fallback path. */
function quoteForCmd(value) {
  const text = String(value)
  if (text !== '' && !/[\s"&|<>^()]/.test(text)) return text
  return `"${text.replaceAll('"', '""')}"`
}

/** Best-effort terminate that never throws. */
function killQuietly(child) {
  try {
    child?.kill()
  } catch {
    /* the process may already be gone */
  }
}

/** Render an unknown thrown value as a short `CODE: message` string. */
function describeError(error) {
  if (error instanceof Error) return `${error.code ?? error.name}: ${error.message}`
  return String(error)
}
