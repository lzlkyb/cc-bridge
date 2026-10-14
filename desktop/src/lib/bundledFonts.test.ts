import { describe, expect, it } from "vitest";
import { BUNDLED_FAMILIES, isBundledFontsReady, subscribeBundledFonts } from "./bundledFonts";
import { FONT_STACKS } from "./terminalFontFamily";
import jetbrainsOfl from "../assets/fonts/jetbrains/OFL.txt?raw";
import firaOfl from "../assets/fonts/fira/OFL.txt?raw";

describe("内置字体", () => {
  // jsdom 没有 FontFace/document.fonts：init 走「缺席即就绪」分支，同步完成。
  it("环境不支持 FontFace 时立即视为就绪（不能挂住任何等待方）", () => {
    expect(isBundledFontsReady()).toBe(true);
  });

  it("订阅接口可用：就绪后订阅不再触发，注销不抛错", () => {
    let n = 0;
    const off = subscribeBundledFonts(() => {
      n += 1;
    });
    off();
    expect(n).toBe(0);
  });

  it("打包 family 与字体栈里写的名字一致（对不上就是静默回退，内置白打）", () => {
    const stacks = FONT_STACKS.map((f) => f.stack).join(" | ");
    for (const family of BUNDLED_FAMILIES) {
      expect(stacks).toContain(`"${family}"`);
    }
    // 内置的两套预设必须以自己的 family 开头——放后面会被栈里前一个字体遮蔽
    const jetbrains = FONT_STACKS.find((f) => f.id === "jetbrains");
    const fira = FONT_STACKS.find((f) => f.id === "fira");
    expect(jetbrains?.stack.startsWith('"JetBrains Mono"')).toBe(true);
    expect(fira?.stack.startsWith('"Fira Code"')).toBe(true);
  });

  it("每套内置字体都随包附带 OFL 许可文本（OFL 要求随分发附带许可证）", () => {
    // ttf 本身不需要单独守卫：bundledFonts.ts 里 import 资产，文件被删/改名时
    // vite 构建与本测试的模块加载都会直接报错。
    for (const [name, ofl] of [
      ["JetBrains Mono", jetbrainsOfl],
      ["Fira Code", firaOfl],
    ] as const) {
      expect(ofl.length, name).toBeGreaterThan(1000);
      expect(ofl, name).toContain("Font Software");
    }
  });
});
