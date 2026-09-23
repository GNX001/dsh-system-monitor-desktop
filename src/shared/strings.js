/**
 * App-only copy (bar tooltips, the tray menu, the settings window), in Chinese
 * and English.
 *
 * The metric labels and the refresh/hide tooltips come from the vendored
 * `locales.js` — the same dictionary the DSH plugin uses — so the two products
 * name things identically. This file only carries what the standalone app adds:
 * docking, click-through, appearance, startup, and the tray.
 */

export const APP_STRINGS = {
  zh: {
    appName: '系统监视状态条',
    trayShowHide: '显示 / 隐藏状态条',
    trayPinned: '吸顶自动收缩',
    trayClickThrough: '点击穿透（鼠标穿透到下层）',
    trayAlwaysOnTop: '窗口置顶',
    trayReset: '重置位置',
    traySettings: '设置…',
    traySettingsFolder: '打开配置文件夹',
    trayShortcut: '快捷键',
    trayQuit: '退出',
    pinOn: '吸顶自动收缩：开',
    pinOff: '吸顶自动收缩：关',
    hide: '隐藏状态条（可从托盘恢复）',
    pinLabel: '图钉',
    settingsLabel: '设置',
    dockedHint: '已吸顶：鼠标移到屏幕顶端即可展开',
    clickThroughOn: '点击穿透已开启：状态条上的按钮点不动了，用托盘菜单或快捷键关掉',

    // Settings window
    settingsTitle: '状态条设置',
    settingsIntro: '改动立即生效并自动保存，不需要按确定。',
    sectionBar: '状态条',
    sectionWindow: '窗口行为',
    sectionGeneral: '通用',
    theme: '主题',
    themeHint: '只改变配色，不影响采样。',
    themeAuto: '跟随系统',
    themeLight: '浅色',
    themeDark: '深色',
    opacity: '背景透明度',
    opacityHint: '只影响底色，文字始终不透明；调低会露出更多背后的内容。',
    pinned: '吸顶自动收缩',
    pinnedHint: '贴在工作区顶边并居中，鼠标离开后向上收起；鼠标碰一下顶端就滑下来。',
    clickThrough: '点击穿透',
    clickThroughHint: '鼠标事件穿过状态条落到下层窗口，此时状态条上的按钮会失效。',
    clickThroughEscape: '关掉它的两条路：右键托盘图标取消勾选，或按快捷键。',
    alwaysOnTop: '窗口置顶',
    alwaysOnTopHint: '始终浮在普通窗口之上，包括最大化的窗口。',
    openAtLogin: '开机自动启动',
    openAtLoginHint: '登录 Windows 后自动运行。这是免安装版，移动文件夹后要重新设置一次。',
    openAtLoginMoved: '开机启动项还指向旧位置（程序被移动过），关掉再打开这一项即可重新登记。',
    language: '语言',
    languageAuto: '跟随系统',
    position: '悬浮位置',
    positionHint: '状态条没吸顶时记在右上角；拖到别处后会记住新位置。',
    resetPosition: '重置位置',
    showBar: '显示状态条',
    hideBar: '隐藏状态条',
    openSettingsFolder: '打开配置文件夹',
    quit: '退出程序',
    shortcutRow: '关闭点击穿透的快捷键',
    shortcutUnavailable: '没有可用组合（请用托盘菜单）',
    settingsFootNote: '设置文件：settings.json（托盘 → 打开配置文件夹）',
  },
  en: {
    appName: 'System monitor bar',
    trayShowHide: 'Show / hide the bar',
    trayPinned: 'Dock to the top edge and auto-hide',
    trayClickThrough: 'Click-through (let the mouse reach what is behind)',
    trayAlwaysOnTop: 'Always on top',
    trayReset: 'Reset position',
    traySettings: 'Settings…',
    traySettingsFolder: 'Open the settings folder',
    trayShortcut: 'Shortcut',
    trayQuit: 'Quit',
    pinOn: 'Dock and auto-hide: on',
    pinOff: 'Dock and auto-hide: off',
    hide: 'Hide the bar (restore it from the tray)',
    pinLabel: 'Pin',
    settingsLabel: 'Settings',
    dockedHint: 'Docked: move the pointer to the top edge to reveal',
    clickThroughOn: 'Click-through is on: the bar\'s buttons no longer respond — turn it off from the tray or the shortcut',

    // Settings window
    settingsTitle: 'Bar settings',
    settingsIntro: 'Changes apply immediately and save themselves. There is nothing to confirm.',
    sectionBar: 'The bar',
    sectionWindow: 'Window behaviour',
    sectionGeneral: 'General',
    theme: 'Theme',
    themeHint: 'Colours only; the sampling is unaffected.',
    themeAuto: 'Follow the system',
    themeLight: 'Light',
    themeDark: 'Dark',
    opacity: 'Background opacity',
    opacityHint: 'The tint only — the text stays fully opaque. Lower reveals more of what is behind.',
    pinned: 'Dock to the top edge and auto-hide',
    pinnedHint: 'Sits centred against the top of the work area and slides up when the pointer leaves; touching the top edge brings it back.',
    clickThrough: 'Click-through',
    clickThroughHint: 'Mouse events pass through the bar to the window behind it, so the bar\'s own buttons stop responding.',
    clickThroughEscape: 'Two ways back: clear it in the tray menu, or use the shortcut.',
    alwaysOnTop: 'Always on top',
    alwaysOnTopHint: 'Floats above ordinary windows, including maximised ones.',
    openAtLogin: 'Start when I sign in',
    openAtLoginHint: 'Runs automatically after you sign in. This build is portable, so moving the folder means setting it again.',
    openAtLoginMoved: 'The sign-in entry still points at the old location (the app was moved). Turn this off and on again to re-register it.',
    language: 'Language',
    languageAuto: 'Follow the system',
    position: 'Floating position',
    positionHint: 'Unpinned, the bar starts in the top-right corner and remembers wherever you drag it.',
    resetPosition: 'Reset position',
    showBar: 'Show the bar',
    hideBar: 'Hide the bar',
    openSettingsFolder: 'Open the settings folder',
    quit: 'Quit',
    shortcutRow: 'Shortcut that turns click-through off',
    shortcutUnavailable: 'none available (use the tray menu)',
    settingsFootNote: 'Settings file: settings.json (tray → open the settings folder)',
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
