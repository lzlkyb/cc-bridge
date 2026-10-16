import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { healMouseTracking, MOUSE_REPORT_OFF, mouseTrackingActive } from "./terminalMouse";

/** 只造用到的成员：modes.mouseTrackingMode 与 write。 */
function fakeTerm(mode: "none" | "x10" | "vt200" | "drag" | "any" = "none"): Terminal {
  return { modes: { mouseTrackingMode: mode }, write: vi.fn() } as unknown as Terminal;
}

describe("MOUSE_REPORT_OFF", () => {
  it("覆盖全部四种追踪模式，且刻意不碰 1006 编码位", () => {
    expect(MOUSE_REPORT_OFF).toContain("\x1b[?1003l");
    expect(MOUSE_REPORT_OFF).toContain("\x1b[?1002l");
    expect(MOUSE_REPORT_OFF).toContain("\x1b[?1000l");
    expect(MOUSE_REPORT_OFF).toContain("\x1b[?9l");
    // 🔴 不关 1006（SGR 编码）：远端从未关过它，本地保持与远端一致——关掉会让
    // 备用屏下 xterm 把滚轮编码成 X10 老式报文，远端按长度切字节切出一屏乱码。
    expect(MOUSE_REPORT_OFF).not.toContain("1006");
  });
});

describe("healMouseTracking（断开 / 换会话接线时的残留治愈）", () => {
  it("本地还开着追踪（上个 TUI 来不及 DECRST 就死了）→ 写 MOUSE_REPORT_OFF", () => {
    const term = fakeTerm("any");
    healMouseTracking(term);
    expect(term.write).toHaveBeenCalledWith(MOUSE_REPORT_OFF);
  });

  it("已经是 none → 零写入（幂等：StrictMode 双调 / 反复接线不会刷屏）", () => {
    const term = fakeTerm("none");
    healMouseTracking(term);
    expect(term.write).not.toHaveBeenCalled();
  });

  it("契约残缺（半销毁的终端）不抛异常，也不写", () => {
    const broken = {} as unknown as Terminal;
    expect(() => healMouseTracking(broken)).not.toThrow();
    expect(mouseTrackingActive(broken)).toBe(false);
  });
});

describe("mouseTrackingActive", () => {
  it("除 none 之外都算追踪态（选择手势据此决定要不要补合成 mousedown）", () => {
    expect(mouseTrackingActive(fakeTerm("none"))).toBe(false);
    for (const m of ["x10", "vt200", "drag", "any"] as const) {
      expect(mouseTrackingActive(fakeTerm(m))).toBe(true);
    }
  });
});
