# 番茄钟 · 专注计时器

[![License: MIT](https://img.shields.io/badge/License-MIT-f97316.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-fb7185.svg)](#技术说明)
[![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-fbbf24.svg)](#技术说明)

> 一个纯前端、零依赖的番茄钟，双击 `index.html` 就能开始专注。

暗色暖橙粉主题，环形进度条 + 大号等宽倒计时，专注 / 短休息 / 长休息自动轮转，自带今日统计与 Web Audio 合成提示音。

---

## 功能特性

- **三种模式**：专注（默认 25 分钟）、短休息（默认 5 分钟）、长休息（默认 15 分钟），可随时手动切换。
- **自定义时长**：每种模式的分钟数都能用加减按钮或输入框调整（1–180 分钟），并自动保存。
- **环形进度条**：SVG 绘制，圆环带渐变与发光滤镜，随剩余时间流逝逐渐收缩。
- **大号倒计时**：`MM:SS` 格式，等宽字体 + 数字对齐，远看也清楚。
- **完整控制**：开始 / 暂停 / 重置 / 跳过当前阶段。
- **自动轮转**：专注结束进入短休息；每完成 4 个专注进入长休息；可开启「自动开始下一阶段」。
- **提示音**：用 Web Audio API 实时合成三音提示音，不依赖任何音频文件；提供音效开关。
- **今日统计**：记录当天完成的专注个数与累计专注分钟数，并用一排 🍅 小方块展示。
- **标题联动**：倒计时运行时标签页标题显示 `24:31 · 专注中`，停止后恢复。
- **键盘快捷键**：空格开始/暂停、`R` 重置、`S` 跳过（输入框聚焦时自动屏蔽）。
- **持久化**：时长、音效开关、自动开始开关、统计数据全部写入 `localStorage`，刷新不丢。
- **响应式**：窄屏可用，手机上按钮自动变大。

---

## 如何开始使用

**方式一：直接双击（最简单）**

打开文件管理器，双击 `index.html`，浏览器即可以 `file://` 方式打开，功能完整可用。

**方式二：起一个本地静态服务器（推荐）**

```bash
cd focus-timer
python -m http.server 8000
```

然后访问 <http://localhost:8000>。若你用的是 Node.js 环境，也可以用：

```bash
npx serve .
```

> 提示：`localStorage` 在同一浏览器 + 同一访问路径下生效。用 `file://` 双击打开和用 `http://localhost` 打开属于不同的存储源，统计数据不会互通，建议固定一种方式使用。

---

## 快捷键

| 按键 | 功能 | 说明 |
| --- | --- | --- |
| <kbd>空格</kbd> | 开始 / 暂停 | 正在倒计时则暂停，暂停中则继续 |
| <kbd>R</kbd> | 重置 | 当前阶段回到完整时长并停止 |
| <kbd>S</kbd> | 跳过 | 直接进入下一阶段（不计入统计） |

> 焦点位于时长输入框内时，快捷键不会触发，方便你正常输入数字。

---

## 项目结构

```text
focus-timer/
├── index.html      # 页面结构：模式切换、进度环、控制按钮、统计、设置
├── style.css       # 样式：暗色暖色主题、圆环、开关、响应式布局
├── app.js          # 逻辑：时间戳计时、阶段轮转、音效、统计、快捷键
├── README.md       # 说明文档（本文件）
├── LICENSE         # MIT 开源协议
└── .gitignore      # 忽略系统与编辑器垃圾文件
```

---

## 技术说明

### 为什么用时间戳计时

很多简易计时器用 `setInterval` 每秒把计数减 1。但浏览器为了省电，会把后台标签页的定时器降频甚至冻结——切回来时倒计时就"少走了"几十秒甚至几分钟。

本项目记录的是**结束时刻的绝对时间戳** `endTime = Date.now() + remainingMs`，每次刷新界面时用 `Date.now()` 与之相减得到真实剩余时间：

```js
function getRemainingMs() {
  if (state.running) return Math.max(0, state.endTime - Date.now());
  return Math.max(0, state.remainingMs);
}
```

`setInterval` 只负责"多久重绘一次界面"，不参与时间计算。因此无论后台降频还是页面卡顿，恢复前台后剩余时间始终准确；暂停时则把当前剩余毫秒固化进 `remainingMs`。

### 提示音是怎么合成的

不使用任何音频文件。阶段切换时创建三个 `OscillatorNode`（正弦波），音高分别为 A5 (880Hz)、D6 (1174.66Hz)、G6 (1567.98Hz)，每个相差 0.16 秒依次触发，配合 `GainNode` 的指数型淡入淡出包络，避免爆音：

```js
gain.gain.setValueAtTime(0.0001, t);
gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
```

浏览器要求音频必须由用户手势解锁。`AudioContext` 因此采用**懒创建**：平时不构造，只在用户点击开始 / 切换开关时才创建并在必要时 `resume()`，从而绕开自动播放限制。

### localStorage 存了什么

| 键 | 内容 |
| --- | --- |
| `focusTimer.settings.v1` | `{ durations: { focus, short, long }, soundOn, autoStart }` |
| `focusTimer.stats.v1` | `{ date: 'YYYY-MM-DD', count, seconds }` |

统计数据带日期字段，每次渲染前会检查是否跨天，一旦发现日期变化就清零重来，避免把昨天的番茄算进今天。读取时全部包在 `try/catch` 中，数据损坏或隐私模式禁用存储时自动退回默认值，不影响使用。

### 环形进度是怎么算的

SVG 的 `<circle>` 用 `stroke-dasharray` 把描边拉成整圈周长，再用 `stroke-dashoffset` 控制可见长度。周长由 `2 × π × r`（r = 120）计算，剩余时间比例为 `fraction` 时偏移量为 `周长 × (1 - fraction)`，于是圆环随剩余时间减少而收缩。

---

## License

本项目基于 [MIT License](LICENSE) 开源。

```text
Copyright (c) 2026 苏小晗
```

你可以自由使用、修改、分发本项目的代码，只需保留原始版权声明。
