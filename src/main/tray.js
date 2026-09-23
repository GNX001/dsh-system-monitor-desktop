import { Menu, Tray, nativeImage, shell } from 'electron'
import { join } from 'node:path'

/**
 * The tray icon and its menu — the control centre.
 *
 * It exists because of click-through: once the bar forwards mouse events to
 * whatever is behind it, nothing drawn on the bar can be clicked, so there has
 * to be a way back that does not depend on the bar at all.
 *
 * @param deps - callbacks and the current state.
 * @returns `{ tray, refresh }` — `refresh` re-reads the check marks after a
 *   change made anywhere else (the pin button on the bar, the shortcut).
 */
export function createTray(deps) {
  const { assetsDir, strings, actions, isVisible } = deps

  const icon = nativeImage.createFromPath(join(assetsDir, 'tray.png'))
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip(strings.appName)
  tray.setIgnoreDoubleClickEvents(false)

  const refresh = () => {
    const menu = Menu.buildFromTemplate([
      { label: strings.trayShowHide, click: () => actions.toggleVisible() },
      { type: 'separator' },
      {
        label: strings.trayPinned,
        type: 'checkbox',
        checked: deps.getSettings().pinned,
        click: (item) => actions.setPinned(item.checked),
      },
      {
        label: strings.trayClickThrough,
        type: 'checkbox',
        checked: deps.getSettings().clickThrough,
        click: (item) => actions.setClickThrough(item.checked),
      },
      {
        label: strings.trayAlwaysOnTop,
        type: 'checkbox',
        checked: deps.getSettings().alwaysOnTop,
        click: (item) => actions.setAlwaysOnTop(item.checked),
      },
      { type: 'separator' },
      { label: strings.trayReset, click: () => actions.resetPosition() },
      { label: `${strings.trayShortcut}: ${deps.shortcut}`, enabled: false },
      { label: strings.traySettingsFolder, click: () => void shell.openPath(deps.settingsDir) },
      { type: 'separator' },
      { label: strings.trayQuit, click: () => actions.quit() },
    ])
    tray.setContextMenu(menu)
  }

  refresh()

  // Left click toggles the bar; that is the least surprising thing a tray icon
  // can do, and it is also the fastest way to bring it back.
  tray.on('click', () => actions.toggleVisible())
  if (isVisible !== undefined) tray.setToolTip(strings.appName)

  return { tray, refresh }
}
