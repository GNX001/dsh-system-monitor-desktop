# dsh-system-monitor-desktop

中文 | [English](README.en.md)

**作者：DeepSeek + DeepSeek-Harness**

[DeepSeek Harness 系统监视器](https://github.com/GNX001/dsh-system-monitor) 的 **Windows 独立桌面版**：不需要 Harness，双击就能跑的一条置顶状态条。

![悬浮状态条](assets/screenshot-floating.png)

```
⣿ CPU 3.2% 71.9°C 丨 MEM 29% 9.1/31.2 GB 丨 GPU 0% 44°C 0/11.9 GB 丨 网速 ↓ 20.1 KB/s ↑ 5.1 KB/s  ⟳ 📌 ✕
```

## 四个重点功能

| 功能 | 说明 |
| --- | --- |
| **吸顶自动收缩** | 钉住后状态条横跨整个屏幕顶端；鼠标离开 0.6 秒就向上收起，只在屏幕顶部留 6px 细边；鼠标碰到顶部边缘立刻滑下来。 |
| **窗口置顶** | 一直浮在普通窗口之上，包括最大化的浏览器。可在托盘里关掉。 |
| **点击穿透** | 开启后鼠标事件直接穿过状态条落到下层窗口，状态条变成纯显示。托盘或快捷键可随时关掉。 |
| **图钉按钮** | 按钮区从右往左依次是 `⟳` 刷新、**`📌` 图钉**、`✕` 隐藏。图钉就在关闭按钮前面，用来开关上面的吸顶收缩；开启时呈高亮按下态。 |

吸顶展开与收起（真实桌面截取，非示意图）：

| 钉住 · 展开 | 钉住 · 收起 |
| --- | --- |
| ![展开](assets/screenshot-docked.png) | 只在屏幕顶端留一条 6px 的圆角细边 |

## 运行

### 直接跑打包版

到 [最新版本](https://github.com/GNX001/dsh-system-monitor-desktop/releases/latest) 下载 `dsh-system-monitor-desktop-<版本>-win-x64.zip`（约 110 MB），解压后双击 `dsh-system-monitor-desktop.exe`。免安装、不写注册表，删掉文件夹就是卸载。

### 从源码跑

```sh
npm install
npm run icons     # 生成 assets/icon.png、icon.ico、tray.png（脚本自己画，无图像库依赖）
npm start
```

### 打包

```sh
npm run dist      # 输出到 dist/dsh-system-monitor-desktop-win32-x64/
```

## 操作

- **拖动**：悬浮状态下按住状态条任意位置拖（按钮除外）。吸顶后不可拖动——位置由屏幕边缘决定。
- **`⟳` 刷新**：立刻重新探测一次硬件，不等下一个采样周期。
- **`📌` 图钉**：开关吸顶自动收缩。
- **`✕` 隐藏**：把状态条收进托盘（**不退出程序**）。要从托盘恢复，左键单击托盘图标，或用菜单里的「显示 / 隐藏状态条」。
- **托盘菜单**：显示/隐藏、吸顶自动收缩、点击穿透、窗口置顶、重置位置、打开配置文件夹、退出。

## 关于点击穿透：怎么关掉它

点击穿透开启后，状态条不再接收任何鼠标事件——**状态条上的按钮点不动了**，这是这个功能的本质，不是 bug。所以有两条退路：

1. **托盘菜单**（最可靠）：右键托盘图标 → 取消勾选「点击穿透」。
2. **全局快捷键**：依次尝试 `Ctrl+Alt+L`、`Ctrl+Alt+B`、`Ctrl+Alt+Y`，取第一个注册成功的（被别的软件占用就顺延）。实际生效的那个会显示在托盘菜单里。

吸顶自动收缩开启时，鼠标仍然能唤出状态条——悬停检测读的是**屏幕光标位置**（`screen.getCursorScreenPoint`），不依赖窗口收到鼠标事件，所以点击穿透和自动收缩可以同时用。

## 配置

设置存在 `%APPDATA%\dsh-system-monitor-desktop\settings.json`，可直接编辑（托盘 → 打开配置文件夹）：

```jsonc
{
  "pinned": false,        // 吸顶自动收缩
  "clickThrough": false,  // 点击穿透
  "alwaysOnTop": true,    // 窗口置顶
  "position": null,       // 悬浮位置 {x, y}；null = 右上角
  "language": "auto"      // auto | zh | en
}
```

文件损坏、字段缺失或类型不对都会退回默认值，不会启动失败。

## 各项数值来自哪里

采集代码与 Harness 插件**逐字节相同**（`tools/verify-vendor.mjs` 会校验，见下），所以数值口径完全一致：

| 指标 | 来源 |
| --- | --- |
| CPU 占用率 | `os.cpus()` 逐核心 jiffies 差分 |
| 内存 | `os.totalmem()` / `os.freemem()`（「可用内存」口径，与任务管理器一致） |
| CPU 温度 | ACPI 热区 PDH 计数器，经 `typeperf` |
| GPU | `nvidia-smi`（含温度、显存、功耗）；没有则退回厂商中立的 Windows GPU 性能计数器（仅占用率） |
| 网速 | PDH 网络计数器，自动排除回环/虚拟适配器，避免重复计算 |

**零运行时依赖**：不装驱动、不提权、不联网、只读。唯一的进程外调用是 `typeperf` 与 `nvidia-smi`，都是系统自带或显卡驱动自带的工具。

> **关于 Windows 的 CPU 温度单位**：PDH 计数器普遍被文档写作「开尔文」，但 ACPI 底层的 `_TMP` 是分度开尔文。实测（Windows 11 + AMD 笔记本）：空闲约 355、4 线程持续满载后稳定在约 367。按开尔文读就是 82 °C → 94 °C，正是一颗笔记本 CPU 卡在 95 °C 温控阈值下方；按分度摄氏度读则变成满载只升温 1.2 °C，任何物理封装都不会这样。因此按开尔文读取。

## 代码来源

`src/shared/` 下的 10 个文件是从 [dsh-system-monitor](https://github.com/GNX001/dsh-system-monitor) 复制来的（8 个采集器 + 视图模型 + 双语字典），逐字节未改。这样两个产品对同一个读数会用同样的格式和同样的颜色阈值。

复制件最容易悄悄漂移，所以做了两重固定：

```sh
node tools/verify-vendor.mjs           # 对照 tools/vendored.json，并在有插件源码时逐字节比对
node tools/verify-vendor.mjs --write   # 重新记录哈希（有意升级复制件时用）
```

`test/app.test.mjs` 只依赖 `tools/vendored.json`，所以即使没有插件源码也能发现漂移。

## 开发

```sh
npm test        # node --test "test/*.test.mjs"
npm run icons   # 重新生成图标
npm run dist    # 打包免安装版
```

### 自检截图

GUI 应用没法只靠单元测试验证，而这个项目在开发时也没有人能盯着屏幕，所以内置了一个会自己走一遍状态的诊断：

```sh
npm start -- --capture            # 输出到 ./capture
npm start -- --capture=D:\shots   # 或指定目录
```

它会依次进入「悬浮 → 钉住展开 → 钉住收起 → 点击穿透 → 回到悬浮」，每一步都用 `desktopCapturer` 抓整个桌面（所以吸顶和置顶是**真的看得见**，不只是网页内容），再用 `capturePage` 抓状态条本体，并把每一步的窗口坐标、图标状态、指标数值写进 `capture/log.txt`。

### 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/main/docking.js` | 吸顶几何与自动伸缩状态机（纯函数，无 Electron 依赖，可单测） |
| `src/main/settings.js` | 设置规范化（纯函数） |
| `src/main/store.js` | JSON 读写（原子写、读失败退回默认值） |
| `src/main/window.js` 等 | 见 `src/main/index.js`；窗口、托盘、IPC、采集循环都在这一层 |
| `src/renderer/` | 状态条本体：原生 DOM，无框架 |
| `src/shared/` | 从插件复制的采集器与视图模型 |
| `tools/` | 图标生成、打包、复制件校验 |

## 已知限制

- **仅 Windows**。吸顶几何本身是跨平台的，但托盘、置顶层级和置顶行为都按 Windows 调过。
- **macOS 不适用**，本仓库也不打算支持。
- 网速与 GPU 的采样各要起一个短命进程（`typeperf` / `nvidia-smi`），分别每 2 秒、1.5 秒一次；CPU 温度每 4 秒。机器极忙时数值会有几秒延迟，这是设计如此——状态条永远不等硬件。
- 版本 0.x，配置项仍可能变动。

## 许可

**The Unlicense** —— 完全自由，无任何使用条件。可以出于任何目的、以任何方式复制、修改、发布、使用、编译、出售或分发，源码或二进制皆可，商用非商用皆可，**无需署名、无需保留任何声明、无需遵守任何条款**。全文见 [LICENSE](LICENSE)。
