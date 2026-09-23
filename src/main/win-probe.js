/**
 * Ask Windows itself what it thinks about the bar's window, and drive it with
 * real injected mouse input.
 *
 * `win.setIgnoreMouseEvents(true)` is a one-line call whose entire effect is a
 * window-style bit (`WS_EX_TRANSPARENT`), and the whole feature — "clicks land on
 * whatever is behind the bar" — is decided by the OS hit-test, not by anything
 * Electron reports. Electron reports success either way, so the only way to tell
 * a working click-through from a broken one is to read the style back and ask
 * Windows which window a point belongs to.
 *
 * **Coordinates here are physical pixels.** Electron reports window bounds in
 * device-independent pixels, while `WindowFromPoint`, `mouse_event` and
 * `GetWindowRect` are all scaled by the calling process's DPI awareness. This
 * module therefore declares per-monitor-v2 awareness before doing anything else,
 * which makes every one of those APIs speak physical pixels; callers convert with
 * {@link toPhysical}. Getting this wrong is silent: the input simply lands
 * somewhere else on screen, and a probe that misses the window reports whichever
 * window it did hit.
 *
 * The scripts are handed to `powershell.exe` as `-EncodedCommand` (base64
 * UTF-16LE), which avoids every layer of shell quoting between here and P/Invoke.
 */
import { runPowerShell } from './powershell.js'

const TIMEOUT_MS = 20000

/** `WS_EX_*` bits worth decoding: they are what makes a click-through overlay work. */
export const EX_STYLE_BITS = {
  transparent: 0x20,
  layered: 0x80000,
  topmost: 0x8,
  noActivate: 0x8000000,
  toolWindow: 0x80,
  appWindow: 0x40000,
}

/** The C# side of the probe, shared by both scripts. */
const PREAMBLE = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DsmProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  public static string Describe(IntPtr h) {
    if (h == IntPtr.Zero) return "0|(none)|(none)";
    StringBuilder cls = new StringBuilder(256); GetClassName(h, cls, 256);
    StringBuilder txt = new StringBuilder(256); GetWindowText(h, txt, 256);
    return h.ToInt64().ToString() + "|" + cls.ToString() + "|" + txt.ToString();
  }
  public static string Cursor() {
    POINT p; if (!GetCursorPos(out p)) return "?";
    return p.X + "," + p.Y;
  }
  public static string Rect(IntPtr h) {
    RECT r; if (!GetWindowRect(h, out r)) return "?";
    return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
  }
}
"@
`

// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, with the pre-1703 fallback. Must
// run before any coordinate is read, or every value below is silently scaled.
const DPI_AWARENESS = `
try { [DsmProbe]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { [DsmProbe]::SetProcessDPIAware() | Out-Null }
`

/** Physical pixel for a DIP point, on the display that owns `origin`. */
export function toPhysical(point, display) {
  const scale = display.scaleFactor ?? 1
  const originX = display.bounds?.x ?? 0
  const originY = display.bounds?.y ?? 0
  return {
    x: Math.round((point.x - originX) * scale + originX),
    y: Math.round((point.y - originY) * scale + originY),
  }
}

function probeScript({ hwnd, x, y, click }) {
  return `
$ErrorActionPreference = 'Stop'
${PREAMBLE}
${DPI_AWARENESS}
$hwnd = [IntPtr]${hwnd}
$pt = New-Object 'DsmProbe+POINT'
$pt.X = ${x}
$pt.Y = ${y}
$wf = [DsmProbe]::WindowFromPoint($pt)
$wfRoot = [DsmProbe]::GetAncestor($wf, 2)
$ex = [DsmProbe]::GetWindowLong($hwnd, -20)
$bits = [ordered]@{}
$bits['transparent'] = (($ex -band 0x20) -ne 0)
$bits['layered'] = (($ex -band 0x80000) -ne 0)
$bits['topmost'] = (($ex -band 0x8) -ne 0)
$bits['noActivate'] = (($ex -band 0x8000000) -ne 0)
$bits['toolWindow'] = (($ex -band 0x80) -ne 0)
$bits['appWindow'] = (($ex -band 0x40000) -ne 0)
$out = [ordered]@{}
$out['hwnd'] = $hwnd.ToInt64()
$out['exStyle'] = ('0x{0:X8}' -f $ex)
$out['bits'] = $bits
$out['windowFromPoint'] = [DsmProbe]::Describe($wf)
$out['fromPointRoot'] = [DsmProbe]::Describe($wfRoot)
$out['pointHitsBar'] = (($wf -eq $hwnd) -or ($wfRoot -eq $hwnd))
$out['foreground'] = [DsmProbe]::Describe([DsmProbe]::GetForegroundWindow())
$out['barRect'] = [DsmProbe]::Rect($hwnd)
$out['screen'] = '' + [DsmProbe]::GetSystemMetrics(0) + 'x' + [DsmProbe]::GetSystemMetrics(1)
$out['cursorBefore'] = [DsmProbe]::Cursor()
if ($${click ? 'true' : 'false'}) {
  [DsmProbe]::SetCursorPos(${x}, ${y}) | Out-Null
  Start-Sleep -Milliseconds 80
  $out['cursorMoved'] = [DsmProbe]::Cursor()
  [DsmProbe]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [DsmProbe]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 150
  $out['foregroundAfterClick'] = [DsmProbe]::Describe([DsmProbe]::GetForegroundWindow())
}
$out | ConvertTo-Json -Compress -Depth 5
`
}

/**
 * Read the window's extended style and the OS hit-test at one physical point.
 *
 * @param options - `{ hwnd, x, y, click }` in **physical** pixels; `click` also
 *   sends a real left click there.
 * @returns the parsed probe result, or `{ error }` if PowerShell failed.
 */
export function probeWindow({ hwnd, x, y, click = false }) {
  return runPowerShell(probeScript({ hwnd, x, y, click }), { timeoutMs: TIMEOUT_MS }).then(
    (result) => result.value ?? { error: result.error, stderr: result.stderr },
  )
}

/**
 * Drag the real mouse across the screen, so a window-drag loop sees genuine input.
 *
 * `SetCursorPos` moves the pointer without necessarily producing mouse input, and
 * a window-move loop is driven by input messages, so the movement is injected as
 * `MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE` (normalised over the primary screen,
 * which is the only display the bar uses).
 *
 * @param options - `{ from, to, steps, stepMs }` in **physical** pixels.
 * @returns `{ ok, cursorAfter }` or `{ error }`.
 */
export function syntheticDrag({ from, to, steps = 40, stepMs = 12 }) {
  const body = `$ErrorActionPreference = 'Stop'
${PREAMBLE}
${DPI_AWARENESS}
$primaryW = [DsmProbe]::GetSystemMetrics(0)
$primaryH = [DsmProbe]::GetSystemMetrics(1)
function Move-To([int]$x, [int]$y) {
  $ax = [int][Math]::Round($x * 65535.0 / ($primaryW - 1))
  $ay = [int][Math]::Round($y * 65535.0 / ($primaryH - 1))
  [DsmProbe]::mouse_event(0x8001, $ax, $ay, 0, [UIntPtr]::Zero)
}
Move-To ${from.x} ${from.y}
Start-Sleep -Milliseconds 150
[DsmProbe]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
for ($i = 1; $i -le ${steps}; $i++) {
  $x = [int](${from.x} + (${to.x} - ${from.x}) * $i / ${steps})
  $y = [int](${from.y} + (${to.y} - ${from.y}) * $i / ${steps})
  Move-To $x $y
  Start-Sleep -Milliseconds ${stepMs}
}
Start-Sleep -Milliseconds 80
[DsmProbe]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
$o = [ordered]@{}
$o['ok'] = $true
$o['screen'] = '' + $primaryW + 'x' + $primaryH
$o['cursorAfter'] = [DsmProbe]::Cursor()
$o | ConvertTo-Json -Compress
`
  return runPowerShell(body, { timeoutMs: TIMEOUT_MS * 4 }).then(
    (result) => result.value ?? { error: result.error, stderr: result.stderr },
  )
}

/**
 * The HWND behind `win.getNativeWindowHandle()`.
 *
 * Windows returns a pointer-sized buffer; older builds and 32-bit targets give
 * four bytes. Reading past the end of the buffer would throw, so the length
 * decides which reader to use.
 */
export function hwndFromHandle(handle) {
  if (!Buffer.isBuffer(handle) || handle.length === 0) return 0
  return handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0)
}
