/**
 * App-only copy (tray menu, button tooltips), in Chinese and English.
 *
 * The metric labels and the refresh/hide tooltips come from the vendored
 * `locales.js` — the same dictionary the DSH plugin uses — so the two products
 * name things identically. This file only carries what the standalone app adds:
 * docking, click-through, and the tray.
 */

export const APP_STRINGS = {
  zh: {
    appName: '系统监视状态条',
    trayShowHide: '显示 / 隐藏状态条',
    trayPinned: '吸顶自动收缩',
    trayClickThrough: '点击穿透（鼠标穿透到下层）',
    trayAlwaysOnTop: '窗口置顶',
    trayReset: '重置位置',
    traySettingsFolder: '打开配置文件夹',
    trayShortcut: '快捷键',
    trayQuit: '退出',
    pinOn: '吸顶自动收缩：开',
    pinOff: '吸顶自动收缩：关',
    hide: '隐藏状态条（可从托盘恢复）',
    pinLabel: '图钉',
    dockedHint: '已吸顶：鼠标移到屏幕顶端即可展开',
    clickThroughOn: '点击穿透已开启，可从托盘或快捷键关闭',
  },
  en: {
    appName: 'System monitor bar',
    trayShowHide: 'Show / hide the bar',
    trayPinned: 'Dock to the top edge and auto-hide',
    trayClickThrough: 'Click-through (let the mouse reach what is behind)',
    trayAlwaysOnTop: 'Always on top',
    trayReset: 'Reset position',
    traySettingsFolder: 'Open the settings folder',
    trayShortcut: 'Shortcut',
    trayQuit: 'Quit',
    pinOn: 'Dock and auto-hide: on',
    pinOff: 'Dock and auto-hide: off',
    hide: 'Hide the bar (restore it from the tray)',
    pinLabel: 'Pin',
    dockedHint: 'Docked: move the pointer to the top edge to reveal',
    clickThroughOn: 'Click-through is on — turn it off from the tray or the shortcut',
  },
}

/**
 * Decide which language to use.
 *
 * `preference` wins when it names a language; otherwise the system locale
 * decides, with anything non-Chinese falling back to English.
 *
 * @param preference - `auto`, `zh` or `en`.
 * @param locale - a BCP-47 tag such as `zh-CN` (or an empty string).
 * @returns `zh` or `en`.
 */
export function resolveLanguage(preference, locale) {
  if (preference === 'zh' || preference === 'en') return preference
  return String(locale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** The dictionary for a resolved language. */
export function stringsFor(language) {
  return APP_STRINGS[language] ?? APP_STRINGS.en
}
