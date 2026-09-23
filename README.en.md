# dsh-system-monitor-desktop

[中文](README.md) | English

**Author: DeepSeek + DeepSeek-Harness**

The **standalone Windows build** of the [DeepSeek Harness system monitor](https://github.com/GNX001/dsh-system-monitor): an always-on-top status bar that runs on its own, no Harness required.

![Floating bar](assets/screenshot-floating.png)

```
⣿ CPU 3.2% 71.9°C 丨 MEM 29% 9.1/31.2 GB 丨 GPU 0% 44°C 0/11.9 GB 丨 网速 ↓ 20.1 KB/s ↑ 5.1 KB/s  ⟳ 📌 ✕
```

## The four features

| Feature | What it does |
| --- | --- |
| **Dock and auto-hide** | Pinned, the bar spans the top of the screen. 0.6 s after the pointer leaves it slides up, leaving a 6 px sliver at the very top edge; touching the top edge brings it straight back down. |
| **Always on top** | Floats above ordinary windows, including a maximised browser. Can be switched off from the tray. |
| **Click-through** | Mouse events pass straight through the bar to whatever is behind it, turning it into a pure readout. Switch it off from the tray or the shortcut. |
| **Pin button** | The buttons, right to left: `⟳` refresh, **`📌` pin**, `✕` hide. The pin sits immediately before the close button and toggles docking; it is highlighted while docking is on. |

Docked, expanded and hidden (real desktop captures, not mockups):

| Docked · expanded | Docked · hidden |
| --- | --- |
| ![Docked](assets/screenshot-docked.png) | only a 6 px rounded sliver remains at the top edge |

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
npm run dist      # writes dist/dsh-system-monitor-desktop-win32-x64/
```

## Using it

- **Drag**: while floating, drag anywhere on the bar except its buttons. Docked, the bar is not draggable — the screen edge decides where it sits.
- **`⟳` refresh**: re-probe the hardware now instead of waiting for the next sample.
- **`📌` pin**: toggle dock-and-auto-hide.
- **`✕` hide**: sends the bar to the tray (**it does not quit**). Bring it back with a left click on the tray icon, or "Show / hide the bar" in the tray menu.
- **Tray menu**: show/hide, dock and auto-hide, click-through, always on top, reset position, open the settings folder, quit.

## Turning click-through back off

Once click-through is on, the bar receives no mouse events at all — **its own buttons stop responding**, which is the point of the feature rather than a bug. Two ways back:

1. **The tray menu** (always available): right-click the tray icon and clear "Click-through".
2. **A global shortcut**: `Ctrl+Alt+L`, then `Ctrl+Alt+B`, then `Ctrl+Alt+Y` — the first that registers wins (the others are skipped if another app holds them). Whichever took is shown in the tray menu.

Revealing a docked bar still works with click-through on, because the hover check reads the **global cursor position** (`screen.getCursorScreenPoint`) rather than relying on the window receiving mouse events.

## Configuration

Settings live in `%APPDATA%\dsh-system-monitor-desktop\settings.json` and can be edited directly (tray → open the settings folder):

```jsonc
{
  "pinned": false,        // dock to the top edge and auto-hide
  "clickThrough": false,  // let mouse events pass through
  "alwaysOnTop": true,    // keep the bar above other windows
  "position": null,       // floating position {x, y}; null means top-right
  "language": "auto"      // auto | zh | en
}
```

A corrupt, partial, or hand-edited file falls back to the defaults rather than failing to start.

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

### Self-capture diagnostic

A GUI app cannot be verified by unit tests alone, and this one was built without a human watching the screen, so it ships a diagnostic that walks itself through every state:

```sh
npm start -- --capture            # writes to ./capture
npm start -- --capture=D:\shots   # or somewhere else
```

It steps through floating → docked-expanded → docked-hidden → click-through → back to floating, and at each step grabs the whole desktop with `desktopCapturer` (so docking and always-on-top are *actually visible*, not just the web content) plus the bar itself with `capturePage`, writing every state's window bounds, icon state and metric values to `capture/log.txt`.

### Layout

| Path | What it is |
| --- | --- |
| `src/main/docking.js` | Dock geometry and the auto-hide state machine (pure, no Electron, fully unit-tested) |
| `src/main/settings.js` | Settings normalization (pure) |
| `src/main/store.js` | JSON IO (atomic write, read failures fall back to defaults) |
| `src/main/index.js` | The window, tray, IPC, and sampling loop |
| `src/renderer/` | The bar itself: plain DOM, no framework |
| `src/shared/` | The collectors and view model copied from the plugin |
| `tools/` | Icon generation, packaging, vendored-file verification |

## Known limitations

- **Windows only.** The dock geometry is portable, but the tray, the always-on-top level, and the behaviour itself were tuned on Windows.
- Not intended for macOS.
- Network throughput and GPU each start a short-lived process (`typeperf` / `nvidia-smi`) every 2 s and 1.5 s; CPU temperature every 4 s. On a very busy machine a reading can lag by a few seconds — by design: the bar never blocks on hardware.
- Version 0.x: the configuration may still change.

## License

**The Unlicense** — completely free, with no conditions on use. Copy, modify, publish, use, compile, sell or distribute it, in source or binary form, for any purpose, commercial or non-commercial, **with no attribution, no notice to keep and no terms to comply with**. See [LICENSE](LICENSE) for the full text.
