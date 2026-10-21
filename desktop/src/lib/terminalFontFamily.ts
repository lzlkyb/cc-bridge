/**
 * 终端字体（族）的持久化与预设表。
 *
 * 🔴 这里给的是**字体栈**而不是单个字体名，且每一项都必须等宽：
 * xterm 按「一个字符一格」度量并渲染，非等宽字体会让字符度量与实际渲染对不上，
 * 整屏错位。栈尾一律挂 CJK 回退——中文按 2 格宽渲染，缺 CJK 就会回退到系统默认字体，
 * 列宽再错一次（TUI 里画表格/边框时最明显）。
 *
 * 🔴 顺带澄清一个常见误解：**xterm.js 不支持编程连字**（`=>` 不会画成 `⇒`，
 * 我们用的 WebGL 渲染路径更不可能）。所以 JetBrains Mono / Cascadia Code 这类字体的
 * 价值在字形、字宽与字符覆盖，不在连字——UI 文案里不要提连字。
 *
 * WHY 不走后端 config：与 `lib/terminalPreset.ts` 同一取舍（纯前端观感偏好，零 Rust 改动），
 * 代价同样是不进备份/恢复。
 */
import { TERMINAL_FONT } from "./terminalTheme";

/**
 * 中英混排兜底。挑的都是系统常见的中文等宽/准等宽字体：
 * 雅黑（Win）→ 苹方（macOS）→ Noto Sans CJK（Linux）。
 */
const CJK_FALLBACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC"';

export type TerminalFontId = "default" | "consolas" | "jetbrains" | "fira";

export interface TerminalFont {
  id: TerminalFontId;
  name: string;
  /** 选择器里那行小字说明。 */
  desc: string;
  /** 直接喂给 xterm 的 `fontFamily`。 */
  stack: string;
}

/**
 * 预览样例：为「挑选」场景设计，两类字符各管一件事。
 *
 * - `Ag 0O 1lI`——各字体字形差异最大、也最容易混淆的组合：a/g 的双层单层、
 *   0/O、1/l/I 的写法正是等宽字体辨识度所在。框线字符不进来（各字体画得几乎一样，
 *   没有区分度），对齐验证交给「中文」二字 + 设置页更大的卡片。
 * - `中文,.`——确认 CJK 宽度与标点：中文按 2 格宽渲染、不回退到非等宽字体。
 */
export const FONT_SAMPLE = "Ag 0O 1lI 中文,.";

/**
 * 字体预设。第 0 项就是 2.7.x 以来的那份字体栈（`terminalTheme.ts` 的 `TERMINAL_FONT`），
 * **一个字符都不要改**：它是默认项，改了等于强迫所有老用户换字体。
 *
 * 🔴 全部 4 套**开箱即用**，不存在「未安装」状态：
 * - JetBrains Mono / Fira Code 随安装包内置（`lib/bundledFonts.ts` 用 FontFace 注册）；
 * - Consolas 是 Windows 自带字体，缺了就走栈内回退。
 * 因此这里不设 probe/url 之类的安装状态字段——曾经的检测 + 下载引导已随内置化删除。
 *
 * 🔴 不设独立的「Cascadia Code」预设：装了 Cascadia 的机器上它与「系统默认」渲染
 * 同一个字体（默认栈首就是 ui-monospace/Cascadia）；没装的机器上它回退 Consolas、
 * 与 Consolas 预设重复——**任何机器上都与另一项重复**，留着只会让人疑惑。
 * 旧版本存过 `cascadia` 的用户由 `toFontId` 窄化回默认项（视觉上无变化）。
 *
 * ⚠️ 中文向预设（Maple Mono、更纱黑体）曾因「无法内置（CJK ttf 动辄 10MB+）」而
 * 依赖用户自装，内置化决策时一并移除；旧版本存过 `maple` / `cjk` 的用户会被
 * `toFontId` 窄化回默认项，无残留影响。所有栈尾仍挂 CJK 回退，中文照常渲染。
 */
export const FONT_STACKS: ReadonlyArray<TerminalFont> = [
  {
    id: "default",
    name: "系统默认",
    desc: "Cascadia Code → JetBrains Mono → Consolas，含中文回退",
    stack: TERMINAL_FONT,
  },
  {
    id: "consolas",
    name: "Consolas",
    desc: "Windows 自带，窄而锐利，同屏信息量最大",
    stack: `Consolas, "Cascadia Mono", ${CJK_FALLBACK}, monospace`,
  },
  {
    id: "jetbrains",
    name: "JetBrains Mono",
    desc: "内置字体，开箱即用；小写字母高度较大，等宽清晰",
    stack: `"JetBrains Mono", "Cascadia Mono", Consolas, ${CJK_FALLBACK}, monospace`,
  },
  {
    id: "fira",
    name: "Fira Code",
    desc: "内置字体，开箱即用；最流行的编程字体，字形经典耐看",
    stack: `"Fira Code", "Cascadia Code", Consolas, ${CJK_FALLBACK}, monospace`,
  },
];

export const DEFAULT_FONT_ID: TerminalFontId = "default";

const KEY = "cc-bridge.terminal-font";

/** 按 id 取字体栈；id 非法时回默认项的栈（调用方不必自己兜底）。 */
export function fontStackOf(id: TerminalFontId): string {
  return (FONT_STACKS.find((f) => f.id === id) ?? FONT_STACKS[0]).stack;
}

/** 窄化：非法值（手改 / 旧版本残留）一律回落默认。 */
export function toFontId(raw: string | null): TerminalFontId {
  return FONT_STACKS.some((f) => f.id === raw) ? (raw as TerminalFontId) : DEFAULT_FONT_ID;
}

export function loadFontId(): TerminalFontId {
  try {
    return toFontId(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_FONT_ID;
  }
}

/** 终端构造时直接要的就是字体栈，省得调用方再转一次。 */
export function loadFontStack(): string {
  return fontStackOf(loadFontId());
}

export function saveFontId(id: TerminalFontId): boolean {
  try {
    localStorage.setItem(KEY, id);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 模块级小 store（与 terminalPreset / terminalAppearance 同一套范式）
 *
 * 🔴 字体是**全局**的：它决定每个字符占多宽，进而决定 cols/rows。
 * 若各终端各存一份，会出现「A 终端按新字体重算了行列、B 还按旧字体」——
 * 同一份设置表现得像两个。所以必须广播给所有开着的终端。
 * ------------------------------------------------------------------ */

const listeners = new Set<() => void>();
let cache = loadFontId();

export function subscribeFontFamily(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getFontId(): TerminalFontId {
  return cache;
}

export function getFontStack(): string {
  return fontStackOf(cache);
}

export function setFontId(id: TerminalFontId): boolean {
  if (cache === id) return saveFontId(id);
  cache = id;
  const saved = saveFontId(id);
  listeners.forEach((l) => l());
  return saved;
}

/** 仅供测试：localStorage 被内存桩替换后必须重读。 */
export function resetFontFamilyForTest(): void {
  cache = loadFontId();
}
