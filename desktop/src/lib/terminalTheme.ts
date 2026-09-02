/**
 * xterm 终端的亮/暗两套调色板。
 *
 * WHY 单独成文件：这些颜色以前散在 `SshTerminal.tsx` 的 Terminal 构造参数里（20 个键写死深色），
 * 加上容器背景 `#1e1e1e` 还在另外两处硬编码。要跟随主题就必须有唯一出处，否则改一处漏一处。
 * 本文件只放**纯数据 + 纯函数**（规则 11 的精神），订阅主题变化的 hook 在 `hooks/useThemeMode.ts`。
 */
import type { ITheme } from "@xterm/xterm";
import type { Theme } from "./theme";

/** 等宽 + 中文 fallback 字体栈：保证中文文件名/日志不乱码。 */
export const TERMINAL_FONT =
  'ui-monospace, SFMono-Regular, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace';

/**
 * 滚动条滑块颜色必须显式给，不能省。
 *
 * xterm 6.0 把滚动条换成了 VS Code 那套 `.xterm-scrollable-element`，滑块颜色由
 * `theme.scrollbarSlider*` 三个键**注入一段 <style>** 决定；不给就走默认
 * `opacity(foreground, 0.2/0.4/0.5)`——深色下等于 rgba(230,230,230,.2) 压在 #1e1e1e 上，
 * 淡到不同显示器/亮度下有的看得见有的看不见。这就是「部分 Win11 电脑看不到滚动条」的来源。
 *
 * 用 8 位十六进制而不是 rgba() 字符串：xterm 的颜色解析对 #rrggbbaa 是确定支持的。
 */
const DARK: ITheme = {
  // 配色对齐「SSH 终端侧边栏折叠」设计稿（方案 A mockup）：高饱和 ANSI 色 + 略提亮主文本，
  // 抵消 canvas 抗锯齿的软感，避免终端整体发灰发雾。背景沿用设计稿 #1e1e1e。
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
 * 亮色调色板：以 VS Code Light+ 为底，但**有两处刻意偏离**，理由写在这里免得后人改回去：
 *
 * 1. `brightWhite` 不用 Light+ 的 `#a5a5a5`，改成和正文同色的 `#24292f`。
 *    TUI（含 Claude Code）普遍拿 brightWhite 当「强调正文」用，照抄浅灰会让主要文字在白底上没法读。
 * 2. `brightGreen` 不用 `#14ce14`，与 `green` 同为 `#107c10`。
 *    荧光绿压在白底上对比度只有 1.9:1，达不到可读线。
 *
 * 已知取舍：大量 TUI 在配色上默认假设黑底，切到亮色后少数用低亮度色画的边框/次要文字会偏淡。
 * 这是「终端完整跟随主题」这个产品选择本身带来的，不是缺陷。
 */
const LIGHT: ITheme = {
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

/**
 * 终端画布外层容器的底色。
 *
 * 必须和 `ITheme.background` 保持一致：xterm 按整行高度铺背景，容器底部通常还剩不到一行的余量，
 * 那一条露的就是容器底色——两者不一致会在终端下沿露出一道异色边。
 */
export const TERMINAL_SURFACE: Record<Theme, string> = {
  dark: "#1e1e1e",
  light: "#ffffff",
};

/** 取当前主题对应的 xterm 调色板。 */
export function terminalTheme(mode: Theme): ITheme {
  return mode === "dark" ? DARK : LIGHT;
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
