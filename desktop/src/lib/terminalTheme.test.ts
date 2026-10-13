import { describe, it, expect } from "vitest";
import {
  TERMINAL_PALETTES,
  TERMINAL_SURFACE,
  TERMINAL_MIN_CONTRAST_LIGHT,
  terminalContrastRatio,
  type TerminalPreset,
} from "./terminalTheme";

/**
 * 亮色终端的可读性回归门禁。
 *
 * WHY 要有这组断言：亮色盘的色值以前是「看着顺眼」挑的，实测有 12/64 项低于 WCAG AA
 * 4.5:1（最严重的 `brightBlack` 只有 2.5:1，而 TUI 画边框/次要文字用的正是它）。
 * 这类问题肉眼很难发现——白底上 `#9aa0ab` 和 `#6b7383` 都「看着挺淡」，只有算出来才知道
 * 前者 2.54:1、后者 4.61:1。所以用测试把下限钉死，以后改配色会立刻红。
 */

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

const PRESETS: TerminalPreset[] = ["indigo", "mono", "classic", "contrast"];

/* ------------------------- WCAG 对比度（与 xterm `rgb.relativeLuminance2` 同口径） ------------------------- */

function relativeLuminance(hex: string): number {
  const c = hex.replace("#", "").slice(0, 6);
  const channel = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** 两色对比度（1 ~ 21）。 */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

/* ------------------------------------ 亮色：全部 ANSI 色必须达标 ------------------------------------ */

describe("亮色盘的 WCAG AA 下限", () => {
  for (const preset of PRESETS) {
    describe(preset, () => {
      const theme = TERMINAL_PALETTES[preset].light;

      for (const key of ANSI_KEYS) {
        it(`${key} 对背景 ≥ ${AA}:1`, () => {
          const ratio = contrastRatio(theme[key]!, theme.background!);
          // 报错时带上实测值，方便直接看要压多少亮度（期望 4.61 比期望 true 有用得多）。
          expect(Math.round(ratio * 100) / 100).toBeGreaterThanOrEqual(AA);
        });
      }

      it(`正文（foreground）对背景 ≥ ${AA}:1`, () => {
        const ratio = contrastRatio(theme.foreground!, theme.background!);
        expect(Math.round(ratio * 100) / 100).toBeGreaterThanOrEqual(AA);
      });
    });
  }
});

/* ------------------------- 深色：正文达标 + 记录「为何深色不开兜底」的不变量 ------------------------- */

describe("深色盘", () => {
  for (const preset of PRESETS) {
    it(`${preset} 正文对背景 ≥ ${AA}:1`, () => {
      const theme = TERMINAL_PALETTES[preset].dark;
      const ratio = contrastRatio(theme.foreground!, theme.background!);
      expect(Math.round(ratio * 100) / 100).toBeGreaterThanOrEqual(AA);
    });

    it(`${preset} 的 black 与 background 同色（深色盘刻意如此，故深色下不开对比度兜底）`, () => {
      // 🔴 这条不是「顺手写的」：xterm 的 minimumContrastRatio 一旦在深色下生效，
      // 就会把 1:1 的 ANSI black 判为不达标并推成灰色（实测 #1e1e1e → #8a8a8a），
      // 改变 ANSI black 的语义。见 terminalContrastRatio 的注释。
      const theme = TERMINAL_PALETTES[preset].dark;
      expect(theme.black).toBe(theme.background);
    });
  }
});

/* --------------------------------------- 兜底阈值的选择 --------------------------------------- */

describe("terminalContrastRatio", () => {
  it("亮色返回 4.5（VS Code 同值）", () => {
    expect(terminalContrastRatio("light")).toBe(TERMINAL_MIN_CONTRAST_LIGHT);
    expect(TERMINAL_MIN_CONTRAST_LIGHT).toBe(4.5);
  });

  it("深色返回 1（= xterm 默认，关闭兜底）", () => {
    expect(terminalContrastRatio("dark")).toBe(1);
  });
});

/* ---------------------------------- 容器底色必须与终端背景一致 ---------------------------------- */

describe("TERMINAL_SURFACE", () => {
  for (const preset of PRESETS) {
    for (const mode of ["dark", "light"] as const) {
      it(`${preset}/${mode} 与 ITheme.background 一致`, () => {
        // 二者不一致会在终端下沿露出一道异色边（容器底部通常剩不到一行的余量）。
        expect(TERMINAL_SURFACE[preset][mode]).toBe(TERMINAL_PALETTES[preset][mode].background);
      });
    }
  }
});
