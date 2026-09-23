import { Menu, Tray, nativeImage, shell } from 'electron'
import { join } from 'node:path'

/**
 * The tray icon and its menu — the control centre.
 *
 * It exists because of click-through: once the bar forwards mouse events to
 * whatever is behind it, nothing drawn on the bar can be clicked, so there has
 * to be a way back that does not depend on the bar at all.
 *
 * Two details that are easy to get wrong:
 *
 * - The menu is **rebuilt** on every change, so the strings and the check marks
 *   are read through callbacks (`getStrings`, `getSettings`). Capturing them
 *   would freeze the language and show stale ticks.
 * - Each checkbox flips the setting from **our own state**
 *   (`!getSettings().x`) instead of reading `item.checked`. Electron's checkbox
 *   items are toggled around the click event, and depending on that ordering for
 *   a security-relevant control like click-through is not worth the risk: a
 *   toggle that silently does nothing is exactly how click-through reads as
 *   broken.
 *
 * @param deps - callbacks for state and the actions the menu offers.
 * @returns `{ tray, refresh }` — `refresh` re-reads the ticks after a change made
 *   anywhere else (the pin button on the bar, the shortcut, the settings window).
 */
export function createTray(deps) {
  const { assetsDir, actions, getSettings, getStrings, getShortcut, isVisible } = deps

  const icon = nativeImage.createFromPath(join(assetsDir, 'tray.png'))
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setIgnoreDoubleClickEvents(false)

  const refresh = () => {
    const strings = getStrings()
    const settings = getSettings()

    tray.setToolTip(strings.appName)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: strings.trayShowHide, click: () => actions.toggleVisible() },
        { type: 'separator' },
        { label: strings.trayPinned, type: 'checkbox', checked: settings.pinned, click: () => actions.setPinned(!getSettings().pinned) },
        {
          label: strings.trayClickThrough,
          type: 'checkbox',
          checked: settings.clickThrough,
          click: () => actions.setClickThrough(!getSettings().clickThrough),
        },
        {
          label: strings.trayAlwaysOnTop,
          type: 'checkbox',
          checked: settings.alwaysOnTop,
          click: () => actions.setAlwaysOnTop(!getSettings().alwaysOnTop),
        },
        { type: 'separator' },
        { label: strings.traySettings, click: () => actions.openSettings() },
        { label: strings.trayReset, click: () => actions.resetPosition() },
        { label: `${strings.trayShortcut}: ${getShortcut()}`, enabled: false },
        { label: strings.traySettingsFolder, click: () => void shell.openPath(deps.settingsDir) },
        { type: 'separator' },
        { label: strings.trayQuit, click: () => actions.quit() },
      ]),
    )
  }

  refresh()

  // Left click toggles the bar; that is the least surprising thing a tray icon
  // can do, and it is also the fastest way to bring it back.
  tray.on('click', () => actions.toggleVisible())

  return { tray, refresh }
}
