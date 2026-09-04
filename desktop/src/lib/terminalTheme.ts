/**
 * xterm 终端的调色板：4 套预设 × 亮/暗主题 = 8 套。
 *
 * WHY 单独成文件：这些颜色以前散在 `SshTerminal.tsx` 的 Terminal 构造参数里（20 个键写死深色），
 * 加上容器背景 `#1e1e1e` 还在另外两处硬编码。要跟随主题就必须有唯一出处，否则改一处漏一处。
 * 本文件只放**纯数据 + 纯函数**（规则 11 的精神），订阅主题变化的 hook 在 `hooks/useThemeMode.ts`。
 *
 * 🔴 滚动条滑块颜色**每一套都必须显式给**，不能省：
 * xterm 6.0 把滚动条换成了 VS Code 那套 `.xterm-scrollable-element`，滑块颜色由
 * `theme.scrollbarSlider*` 三个键**注入一段 <style>** 决定；不给就走默认
 * `opacity(foreground, 0.2/0.4/0.5)`——深色下等于把前景色压 20% 透明度铺在背景上，
 * 淡到不同显示器/亮度下有的看得见有的看不见。这就是「部分 Win11 电脑看不到滚动条」的来源。
 * 用 8 位十六进制而不是 rgba() 字符串：xterm 的颜色解析对 #rrggbbaa 是确定支持的。
 */
import type { ITheme } from "@xterm/xterm";
import type { Theme } from "./theme";

/** 终端预设（风格）。`indigo` 为默认，其色值与本文件改造前完全一致 —— 老用户零感知。 */
export type TerminalPreset = "indigo" | "mono" | "classic" | "contrast";

/** 等宽 + 中文 fallback 字体栈：保证中文文件名/日志不乱码。 */
export const TERMINAL_FONT =
  'ui-monospace, SFMono-Regular, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace';

/* ============================== indigo（默认） ============================== */

/**
 * 靖蓝 · 深色。
 *
 * 配色对齐「SSH 终端侧边栏折叠」设计稿（方案 A mockup）：高饱和 ANSI 色 + 略提亮主文本，
 * 抵消 canvas 抗锯齿的软感，避免终端整体发灰发雾。背景沿用设计稿 #1e1e1e。
 *
 * 🔴 这是 2.7.x 及以前的唯一配色，**色值一个都不要改**：`indigo` 是默认预设，
 * 改了就等于强迫所有老用户换肤。要调色请新增预设，不要动这里。
 */
const INDIGO_DARK: ITheme = {
  background: "#1e1e1e",
  foreground: "#e6e6e6",
  cursor: "#e6e6e6",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  scrollbarSliderBackground: "#ffffff47",
  scrollbarSliderHoverBackground: "#ffffff6b",
  scrollbarSliderActiveBackground: "#ffffff8f",
  black: "#1e1e1e",
  red: "#f44747",
  green: "#22c55e",
  yellow: "#dcdcaa",
  blue: "#60a5fa",
  magenta: "#c4b5fd",
  cyan: "#4ec9b0",
  white: "#e6e6e6",
  brightBlack: "#8a8a8a",
  brightRed: "#f44747",
  brightGreen: "#22c55e",
  brightYellow: "#dcdcaa",
  brightBlue: "#60a5fa",
  brightMagenta: "#c4b5fd",
  brightCyan: "#4ec9b0",
  brightWhite: "#ffffff",
};

/**
 * 靖蓝 · 亮色：以 VS Code Light+ 为底，但**有两处刻意偏离**，理由写在这里免得后人改回去：
 *
 * 1. `brightWhite` 不用 Light+ 的 `#a5a5a5`，改成和正文同色的 `#24292f`。
 *    TUI（含 Claude Code）普遍拿 brightWhite 当「强调正文」用，照抄浅灰会让主要文字在白底上没法读。
 * 2. `brightGreen` 不用 `#14ce14`，与 `green` 同为 `#107c10`。
 *    荧光绿压在白底上对比度只有 1.9:1，达不到可读线。
 *
 * 已知取舍：大量 TUI 在配色上默认假设黑底，切到亮色后少数用低亮度色画的边框/次要文字会偏淡。
 * 这是「终端完整跟随主题」这个产品选择本身带来的，不是缺陷。
 */
const INDIGO_LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#24292f",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  scrollbarSliderBackground: "#00000042",
  scrollbarSliderHoverBackground: "#00000066",
  scrollbarSliderActiveBackground: "#0000008a",
  black: "#24292f",
  red: "#cd3131",
  green: "#107c10",
  yellow: "#9a6700",
  blue: "#0451a5",
  magenta: "#8250df",
  cyan: "#0598bc",
  white: "#6e7781",
  brightBlack: "#6e7781",
  brightRed: "#cd3131",
  brightGreen: "#107c10",
  brightYellow: "#9a6700",
  brightBlue: "#0451a5",
  brightMagenta: "#8250df",
  brightCyan: "#0598bc",
  brightWhite: "#24292f",
};

/* ============================== mono（极简） ============================== */

/**
 * 极简 · 深色：近黑冷灰底 + **低饱和** ANSI。
 *
 * 关键取舍：ANSI 16 色**不能真的做成单色**。远端程序（`ls`、`git`、Claude Code TUI）
 * 靠色相区分信息，全灰会让它们彻底失效。所以这里是「去霓虹」而不是「去彩色」——
 * 保留可分辨的色相，只把饱和度压下来，长时间盯着不累。
 */
const MONO_DARK: ITheme = {
  background: "#16181d",
  foreground: "#d4d7de",
  cursor: "#d4d7de",
  cursorAccent: "#16181d",
  selectionBackground: "#3a4250",
  scrollbarSliderBackground: "#ffffff3d",
  scrollbarSliderHoverBackground: "#ffffff5c",
  scrollbarSliderActiveBackground: "#ffffff80",
  black: "#16181d",
  red: "#d98a8a",
  green: "#8fbf9a",
  yellow: "#d6c78a",
  blue: "#8fa8d9",
  magenta: "#b39ad0",
  cyan: "#8fcbd0",
  white: "#d4d7de",
  brightBlack: "#7a7f8c",
  brightRed: "#e8a0a0",
  brightGreen: "#a3d4ad",
  brightYellow: "#e6d89b",
  brightBlue: "#a3bce8",
  brightMagenta: "#c9b3e0",
  brightCyan: "#a3dde2",
  brightWhite: "#ffffff",
};

/** 极简 · 亮色：近白冷灰底 + 沉稳 ANSI（亮底上必须压暗，否则对比度不够）。 */
const MONO_LIGHT: ITheme = {
  background: "#fbfbfc",
  foreground: "#3a3f4a",
  cursor: "#3a3f4a",
  cursorAccent: "#fbfbfc",
  selectionBackground: "#cdd6e4",
  scrollbarSliderBackground: "#0000003d",
  scrollbarSliderHoverBackground: "#0000005c",
  scrollbarSliderActiveBackground: "#00000080",
  black: "#3a3f4a",
  red: "#a85454",
  green: "#3f7a4a",
  yellow: "#8a6d1f",
  blue: "#3a5f9e",
  magenta: "#7a4fa0",
  cyan: "#2a7d8f",
  white: "#6b7280",
  brightBlack: "#9aa0ab",
  brightRed: "#b85c5c",
  brightGreen: "#47874f",
  brightYellow: "#9c7a24",
  brightBlue: "#4169ad",
  brightMagenta: "#8a5ab5",
  brightCyan: "#2f8ba0",
  brightWhite: "#3a3f4a",
};

/* ============================== classic（经典终端） ============================== */

/** 经典 · 深色：CRT 磷光绿。高亮度绿配近黑底，靠高饱和做出辉光观感。 */
const CLASSIC_DARK: ITheme = {
  background: "#0b110b",
  foreground: "#4ade80",
  cursor: "#33ff66",
  cursorAccent: "#0b110b",
  selectionBackground: "#1f4a2a",
  scrollbarSliderBackground: "#4ade8059",
  scrollbarSliderHoverBackground: "#4ade8080",
  scrollbarSliderActiveBackground: "#4ade80a6",
  black: "#0b110b",
  red: "#ff6b5e",
  green: "#33ff66",
  yellow: "#ffd866",
  blue: "#6bb8ff",
  magenta: "#ff8ac4",
  cyan: "#5ff5f5",
  white: "#d8f5e0",
  brightBlack: "#2f5a38",
  brightRed: "#ff8a7a",
  brightGreen: "#6bffa0",
  brightYellow: "#ffe89a",
  brightBlue: "#8fccff",
  brightMagenta: "#ffa8d8",
  brightCyan: "#8fffff",
  brightWhite: "#ccffdd",
};

/**
 * 经典 · 亮色 = **暖纸感**（米黄底 + 深墨字），**不是**「磷光绿压白底」。
 *
 * 🔴 为什么不能硬套磷光绿：`#33ff66` 这类高亮度绿压在白底上对比度远低于 3:1，
 * 与上面 `INDIGO_LIGHT` 里把 `brightGreen` 从 `#14ce14` 改成 `#107c10` 是同一类问题（那条注释有实测值）。
 * 所以亮色变体另起炉灶：保留「经典」的复古气质，但换成纸感墨字，先保可读。
 */
const CLASSIC_LIGHT: ITheme = {
  background: "#f4f1e8",
  foreground: "#2b2b2b",
  cursor: "#2b2b2b",
  cursorAccent: "#f4f1e8",
  selectionBackground: "#d9d2bd",
  scrollbarSliderBackground: "#0000003d",
  scrollbarSliderHoverBackground: "#0000005c",
  scrollbarSliderActiveBackground: "#00000080",
  black: "#2b2b2b",
  red: "#b03a2e",
  green: "#1e7a3c",
  yellow: "#8a6d1f",
  blue: "#1f4e79",
  magenta: "#7d3c98",
  cyan: "#0e6b6b",
  white: "#5a5a5a",
  brightBlack: "#a0937f",
  brightRed: "#c24434",
  brightGreen: "#248a45",
  brightYellow: "#9c7a24",
  brightBlue: "#245a8a",
  brightMagenta: "#8e46ad",
  brightCyan: "#107a7a",
  brightWhite: "#2b2b2b",
};

/* ============================== contrast（高对比） ============================== */

/** 高对比 · 深色：纯黑底 + 拉满亮度的 ANSI。弱光、投影、无障碍场景。 */
const CONTRAST_DARK: ITheme = {
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
  cursorAccent: "#000000",
  selectionBackground: "#3b3b3b",
  scrollbarSliderBackground: "#ffffff73",
  scrollbarSliderHoverBackground: "#ffffffa6",
  scrollbarSliderActiveBackground: "#ffffffff",
  black: "#000000",
  red: "#ff6b6b",
  green: "#69ff94",
  yellow: "#ffe066",
  blue: "#6bb9ff",
  magenta: "#ff9ce0",
  cyan: "#66f5ff",
  white: "#ffffff",
  brightBlack: "#7a7a7a",
  brightRed: "#ff8f8f",
  brightGreen: "#8affae",
  brightYellow: "#ffeb99",
  brightBlue: "#8fccff",
  brightMagenta: "#ffb5e8",
  brightCyan: "#8ff8ff",
  brightWhite: "#ffffff",
};

/** 高对比 · 亮色：纯白底 + 高浓度 ANSI（亮底上要加深，不是把深色版简单反过来）。 */
const CONTRAST_LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#000000",
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "#b8d4ff",
  scrollbarSliderBackground: "#00000059",
  scrollbarSliderHoverBackground: "#0000008c",
  scrollbarSliderActiveBackground: "#000000bf",
  black: "#000000",
  red: "#cc0000",
  green: "#006b1f",
  yellow: "#7a5200",
  blue: "#0033a0",
  magenta: "#6b0080",
  cyan: "#005c66",
  white: "#4a4a4a",
  brightBlack: "#767676",
  brightRed: "#d90000",
  brightGreen: "#007526",
  brightYellow: "#8a5d00",
  brightBlue: "#0040c0",
  brightMagenta: "#7a0090",
  brightCyan: "#006b78",
  brightWhite: "#000000",
};

/** 4 套预设 × 亮/暗 = 8 套调色板。 */
export const TERMINAL_PALETTES: Record<TerminalPreset, Record<Theme, ITheme>> = {
  indigo: { dark: INDIGO_DARK, light: INDIGO_LIGHT },
  mono: { dark: MONO_DARK, light: MONO_LIGHT },
  classic: { dark: CLASSIC_DARK, light: CLASSIC_LIGHT },
  contrast: { dark: CONTRAST_DARK, light: CONTRAST_LIGHT },
};

/**
 * 终端画布外层容器的底色（按预设 × 主题）。
 *
 * 必须和 `ITheme.background` 保持一致：xterm 按整行高度铺背景，容器底部通常还剩不到一行的余量，
 * 那一条露的就是容器底色——两者不一致会在终端下沿露出一道异色边。
 */
export const TERMINAL_SURFACE: Record<TerminalPreset, Record<Theme, string>> = {
  indigo: { dark: "#1e1e1e", light: "#ffffff" },
  mono: { dark: "#16181d", light: "#fbfbfc" },
  classic: { dark: "#0b110b", light: "#f4f1e8" },
  contrast: { dark: "#000000", light: "#ffffff" },
};

/** 取「主题 + 预设」对应的 xterm 调色板。 */
export function terminalTheme(mode: Theme, preset: TerminalPreset = "indigo"): ITheme {
  return TERMINAL_PALETTES[preset][mode];
}

/**
 * 滚动历史行数。
 *
 * xterm 默认只有 **1000 行**，`tail -f` 或构建日志一冲就没了。
 * 但它**有真实内存代价**：xterm 的 BufferLine 每个 cell 占约 12 字节，
 * 5000 行 × 200 列 ≈ 12 MB/会话，开四个会话就是 50 MB 量级。
 * 所以取 5000 而不是 10000——再大应该做成设置项而不是默认值。
 */
export const TERMINAL_SCROLLBACK = 5000;

/**
 * 搜索命中项的高亮色。
 *
 * 注意 `matchOverviewRuler` 与 `activeMatchColorOverviewRuler` 在 `ISearchDecorationOptions`
 * 里是**必填**的（类型定义里没有 `?`），不能只给背景色。
 * 用琥珀色而不是主色：主色（靖蓝）在终端里容易与 ANSI blue 混。
 *
 * 已知取舍：这套高亮**不随预设变化**。琥珀在 4 套预设里都与 ANSI 色区分得开，
 * 且搜索是临时态而非长期观感，暂不为它再扩 8 套。
 */
export function searchDecorations(mode: Theme) {
  const dark = mode === "dark";
  return {
    matchBackground: dark ? "#7c5b12" : "#ffe08a",
    matchOverviewRuler: "#d97706",
    activeMatchBackground: dark ? "#d97706" : "#f59e0b",
    activeMatchBorder: dark ? "#fbbf24" : "#b45309",
    activeMatchColorOverviewRuler: "#f59e0b",
  };
}
