/**
 * Bilingual copy. Registered with the DSH locale service under
 * {@link LOCALE_NS}; the tile and the settings panel read strings through the
 * bound `t`. Keys are flat and identical across both dictionaries —
 * `test/client-model.test.mjs` asserts the two stay in sync.
 *
 * `labelCpu` / `labelMem` / `labelGpu` are deliberately identical in both
 * languages: they are the conventional short tags a status readout uses. Only
 * the network tag is translated, because there is no equally universal short
 * form for it.
 */

export const zh = {
  title: '系统监视',
  settingsTitle: '系统监视磁贴',
  settingsHint:
    '悬浮磁贴以纯文字显示本机 CPU、内存、所有 GPU 与网速；温度来自 Windows ACPI 热区计数器或 Linux 内核传感器，显存与功耗来自厂商工具（如 nvidia-smi），网速来自系统自身的网络计数器。所有数据仅在本机回环地址上读取。',
  enable: '显示悬浮磁贴',
  enableHint: '关闭后磁贴会隐藏，可随时在此重新打开。',
  interval: '刷新间隔',
  intervalSecond: '{n} 秒',
  opacity: '不透明度',
  sections: '显示内容',
  showCpu: 'CPU',
  showCpuTemperature: 'CPU 温度',
  showMemory: '内存',
  showGpu: 'GPU',
  showGpuTemperature: 'GPU 温度',
  showGpuMemory: '显存',
  showPower: 'GPU 功耗',
  showNetwork: '网速（上行与下行）',
  appearance: '外观',
  compact: '紧凑模式',
  resetPosition: '重置位置',
  resetAll: '恢复默认设置',
  refresh: '立即刷新',
  hide: '隐藏磁贴',
  loading: '读取中…',
  offline: '宿主插件未响应',
  labelCpu: 'CPU',
  labelMem: 'MEM',
  labelGpu: 'GPU',
  labelGpuN: 'GPU{n}',
  labelNet: '网速',
}

export const en = {
  title: 'System monitor',
  settingsTitle: 'System monitor tile',
  settingsHint:
    'The floating tile is a plain-text readout of CPU, memory, every GPU and network throughput. Temperatures come from Windows ACPI thermal-zone counters or Linux kernel sensors; VRAM and power come from vendor tools such as nvidia-smi; throughput comes from the operating system\u2019s own network counters. Every reading is served over loopback only.',
  enable: 'Show the floating tile',
  enableHint: 'Turning this off hides the tile; reopen it here at any time.',
  interval: 'Refresh interval',
  intervalSecond: '{n}s',
  opacity: 'Opacity',
  sections: 'Sections',
  showCpu: 'CPU',
  showCpuTemperature: 'CPU temperature',
  showMemory: 'Memory',
  showGpu: 'GPU',
  showGpuTemperature: 'GPU temperature',
  showGpuMemory: 'VRAM',
  showPower: 'GPU power draw',
  showNetwork: 'Network speed (up and down)',
  appearance: 'Appearance',
  compact: 'Compact mode',
  resetPosition: 'Reset position',
  resetAll: 'Restore defaults',
  refresh: 'Refresh now',
  hide: 'Hide the tile',
  loading: 'Reading…',
  offline: 'Host plugin not answering',
  labelCpu: 'CPU',
  labelMem: 'MEM',
  labelGpu: 'GPU',
  labelGpuN: 'GPU{n}',
  labelNet: 'NET',
}

/** Substitution-based formatter used when the DSH locale service is absent. */
export function format(template, params) {
  if (params === undefined) return template
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  )
}

/** Build a standalone `t` for one dictionary. */
export function bindDictionary(dictionary) {
  return (key, params) => {
    const template = dictionary[key]
    if (typeof template !== 'string') return key
    return format(template, params)
  }
}
