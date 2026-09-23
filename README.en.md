# dsh-system-monitor-desktop

[中文](README.md) | English

**Author: DeepSeek + DeepSeek-Harness**

The **standalone Windows build** of the [DeepSeek Harness system monitor](https://github.com/GNX001/dsh-system-monitor): an always-on-top status bar that runs on its own, no Harness required.

![Floating bar](assets/screenshot-floating.png)

```
⣿ CPU 3.2% 71.9°C 丨 MEM 29% 9.1/31.2 GB 丨 GPU 0% 44°C 0/11.9 GB 丨 网速 ↓ 20.1 KB/s ↑ 5.1 KB/s  ⚙ ⟳ 📌 ✕
```

## Features

| Feature | What it does |
| --- | --- |
| **Dock and auto-hide** | Pinned, the bar **keeps its own width** and sits centred against the top of the work area. 0.6 s after the pointer leaves it slides up, leaving a 6 px sliver at the very top edge; touching the top edge brings it straight back down. |
| **Always on top** | Floats above ordinary windows, including a maximised browser. Switch it off from the settings window or the tray. |
| **Click-through** | Mouse events pass straight through the bar to whatever is behind it, turning it into a pure readout. |
| **Pin button** | The buttons, right to left: `✕` hide, **`📌` pin**, `⟳` refresh, `⚙` settings. The pin sits immediately before the close button and toggles docking; it is highlighted while docking is on. |
| **Settings window** | Opened by `⚙` or the tray menu. Switches, theme, opacity and language all apply immediately and save themselves — there is no OK button. |
| **Theme** | Follow the system, light, or dark. |
| **Background opacity** | 20%–100% with a live preview. The tint fades; the text never does. |
| **No taskbar button** | The app lives in the tray, and does not add an icon to the taskbar. |
| **Start when I sign in** | One switch in the settings window. |

Docked, hidden, and showing the opacity slider at work (real desktop captures, not mockups):

| Docked · expanded (own width, centred) | Docked · hidden (6 px at the top) | 35% opacity |
| --- | --- | --- |
| ![Docked](assets/screenshot-docked.png) | ![Hidden](assets/screenshot-collapsed.png) | ![Translucent](assets/screenshot-transparent.png) |

The settings window, from the `⚙` button or the tray menu:

![Settings window](assets/screenshot-settings.png)

## Running it

### Packaged build

Download `dsh-system-monitor-desktop-<version>-win-x64.zip` (about 110 MB) from the [latest release](https://github.com/GNX001/dsh-system-monitor-desktop/releases/latest) and run `dsh-system-monitor-desktop.exe`. No installer, no registry entries — deleting the folder uninstalls it.

### From source

```sh
npm install
npm run icons     # generates assets/icon.png, icon.ico, tray.png (drawn by the script, no image library)
npm start
```

### Packaging

```sh
npm run dist      # writes dist/dsh-system-monitor-desktop-win-x64/
```

## Using it

- **Drag**: while floating, drag anywhere on the bar except its buttons. Docked, the bar is not draggable — the screen edge decides where it sits.
- **`⚙` settings**: opens the settings window.
- **`⟳` refresh**: re-probe the hardware now instead of waiting for the next sample.
- **`📌` pin**: toggle dock-and-auto-hide.
- **`✕` hide**: sends the bar to the tray (**it does not quit**). Bring it back with a left click on the tray icon, or "Show / hide the bar" in the tray menu.
- **Tray menu**: show/hide, dock and auto-hide, click-through, always on top, settings, reset position, open the settings folder, quit.

> Docked, the bar **keeps its own width** — it is not stretched into a band across the screen. What stays at the top edge while hidden is a 6 px rounded sliver the width of the bar itself; put the pointer on it to bring the bar back.

## Turning click-through back off

Once click-through is on, the bar receives no mouse events at all — **its own buttons stop responding**, which is the point of the feature rather than a bug. While it is on the buttons are visibly dimmed and the outline turns dashed, so the state is obvious at a glance. Two ways back:

1. **The tray menu** (always available): right-click the tray icon and clear "Click-through".
2. **A global shortcut**: `Ctrl+Alt+L`, then `Ctrl+Alt+B`, then `Ctrl+Alt+Y` — the first that registers wins (the others are skipped if another app holds them). Whichever took is shown in the tray menu and in the settings window.

Revealing a docked bar still works with click-through on, because the hover check reads the **global cursor position** (`screen.getCursorScreenPoint`) rather than relying on the window receiving mouse events.

### Did it actually work? There is a command that asks Windows

`setIgnoreMouseEvents` reports nothing, so this repository ships a self-check that asks the operating system directly:

```sh
npm run probe          # writes to ./probe
```

It reads the window's extended style back (`WS_EX_TRANSPARENT` — set or not), asks `WindowFromPoint` which window a coordinate belongs to, sends a **real mouse click** and sees where it lands — then drags, re-asserts always-on-top, hides and re-shows, and runs the dock cycle, re-reading the bit after each, because those calls go through `SetWindowPos` and could plausibly drop it.

A real run, with click-through on:

```
[probe] on-no-options
[probe]   exStyle=0x00080028 bits={"transparent":true,"layered":true,"topmost":true,...}
[probe]   windowFromPoint=66018|SysListView32|FolderView  pointHitsBar=false
[probe]   real click at (2433,41) -> renderer saw 0; foreground after: 66014|Progman|Program Manager
[probe]   -> click-through EFFECTIVE
```

Read it as: `transparent:true` — the style bit really is set; `pointHitsBar=false` — Windows does not consider that coordinate to be the bar; and after a real click the foreground window is `Progman` (the desktop itself) while the bar's renderer "saw 0 clicks" — the click went through. The control step (click-through off) is the mirror image: `transparent:false`, `pointHitsBar=true`, and the renderer receives the click.

## Configuration

Settings live in `%APPDATA%\dsh-system-monitor-desktop\settings.json` and can be edited directly (tray → open the settings folder):

```jsonc
{
  "pinned": false,        // dock to the top edge and auto-hide
  "clickThrough": false,  // let mouse events pass through
  "alwaysOnTop": true,    // keep the bar above other windows
  "openAtLogin": false,   // start when I sign in
  "theme": "auto",        // auto | light | dark
  "opacity": 0.94,        // background opacity, 0.2–1
  "position": null,       // floating position {x, y}; null means top-right
  "language": "auto"      // auto | zh | en
}
```

A corrupt, partial, or hand-edited file falls back to the defaults rather than failing to start, and an out-of-range opacity is clamped into 0.2–1 (fully transparent would leave the text floating over the desktop, which is unreadable).

## Where the numbers come from

The collectors are **byte-identical** to the Harness plugin's (`tools/verify-vendor.mjs` proves it — see below), so both products measure and format everything the same way:

| Reading | Source |
| --- | --- |
| CPU utilization | `os.cpus()` per-core jiffy deltas |
| Memory | `os.totalmem()` / `os.freemem()` (the "available" figure Task Manager shows) |
| CPU temperature | ACPI thermal-zone PDH counters via `typeperf` |
| GPU | `nvidia-smi` (temperature, VRAM, power); falls back to the vendor-neutral Windows GPU performance counters (utilization only) |
| Network | PDH network counters, with loopback and virtual adapters excluded so the total is not double-counted |

**No runtime dependencies**: no drivers, no elevation, no network access, read-only. The only processes it starts are `typeperf` and `nvidia-smi`, both shipped with Windows or the graphics driver.

> **On the Windows CPU-temperature unit.** The PDH counter is widely documented as "degrees Kelvin", but ACPI's underlying `_TMP` is deci-Kelvin. Measured on a Windows 11 AMD laptop: ~355 at rest and ~367 under sustained 4-thread load. Read as Kelvin that is 82 °C → 94 °C — a laptop CPU settling under its 95 °C throttle. Read as deci-Celsius the same trace would be a 1.2 °C rise under full load, which no physical package does. It is therefore read as Kelvin.

## Where the code came from

The ten files under `src/shared/` are copied from [dsh-system-monitor](https://github.com/GNX001/dsh-system-monitor) (eight collectors, the view model, and the bilingual dictionary), unchanged. That is what makes the two products agree on the format and the colour thresholds of a reading.

Copies drift silently, so they are pinned twice:

```sh
node tools/verify-vendor.mjs           # checks tools/vendored.json, and compares against the plugin source when present
node tools/verify-vendor.mjs --write   # re-records the hashes (when upgrading the copies on purpose)
```

`test/app.test.mjs` needs only `tools/vendored.json`, so drift is caught even with no plugin checkout around.

## Development

```sh
npm test        # node --test "test/*.test.mjs"
npm run icons   # regenerate the icons
npm run dist    # build the portable folder
```

### Self-check diagnostics

A GUI app cannot be verified by unit tests alone, and this one was built without a human watching the screen, so it ships several diagnostics that walk themselves through the behaviour and write down what happened — as text and as pictures. They are all `electron . --xxx`, and they work in the packaged build too.

```sh
npm run capture                 # walk every state and screenshot it into ./capture
npm run probe                   # ask Windows whether click-through really works, into ./probe
npm run drag                    # drag the bar with real mouse input, into ./drag
npm run login-test              # round-trip the sign-in entry (and restore it)
```

Or choose a directory: `npm start -- --capture=D:\shots`.

| Diagnostic | The question it answers |
| --- | --- |
| `--capture` | What each state (floating, docked-expanded, docked-hidden, click-through, light+translucent, dark+opaque, the settings window) actually looks like on a real desktop: a whole-screen grab, the bar alone, and a readable band around the bar, with every step's window bounds, theme, opacity and metric values logged to `log.txt`. |
| `--probe` | Whether click-through really takes effect (the extended-style bit, `WindowFromPoint`, and a real click), and whether the bit survives dragging, always-on-top, hide/show and the dock cycle. Coordinates are converted to physical pixels — otherwise the injected mouse lands somewhere else entirely. |
| `--drag` | Whether dragging is smooth: it injects a real drag and counts the movement events received, the bounds writes issued *during* the drag (the source of the stutter, now deferred to the end), and how far a mid-drag write would have yanked the bar away from the pointer. |
| `--login-test` | Whether the sign-in entry really registered (read back through the registry), restoring the original value afterwards. |

### Layout

| Path | What it is |
| --- | --- |
| `src/main/docking.js` | Dock geometry and the auto-hide state machine (pure, no Electron, fully unit-tested) |
| `src/main/settings.js` | Settings normalization (pure) |
| `src/main/store.js` | JSON IO (atomic write, read failures fall back to defaults) |
| `src/main/win-probe.js` | Diagnostics: hands PowerShell an `-EncodedCommand` that P/Invokes to read window style bits, hit-test, and inject real mouse input |
| `src/main/index.js` | The window, tray, IPC, sampling loop and drag detection |
| `src/renderer/` | The bar itself: plain DOM, no framework |
| `src/settings/` | The settings window: plain DOM, no framework |
| `src/shared/` | The collectors and view model copied from the plugin |
| `tools/` | Icon generation, packaging, vendored-file verification |

## Known limitations

- **Windows only.** The dock geometry is portable, but the tray, the always-on-top level, click-through, and the drag behaviour were tuned on Windows.
- Not intended for macOS.
- Network throughput and GPU each start a short-lived process (`typeperf` / `nvidia-smi`) every 2 s and 1.5 s; CPU temperature every 4 s. On a very busy machine a reading can lag by a few seconds — by design: the bar never blocks on hardware.
- The sign-in entry records the executable's full path. This is a portable build, so **moving the folder means setting it again**.
- The settings window is hidden from the taskbar too; open it from `⚙` or the tray menu, and click again if it is behind something.
- Version 0.x: the configuration may still change.

## License

**The Unlicense** — completely free, with no conditions on use. Copy, modify, publish, use, compile, sell or distribute it, in source or binary form, for any purpose, commercial or non-commercial, **with no attribution, no notice to keep and no terms to comply with**. See [LICENSE](LICENSE) for the full text.
