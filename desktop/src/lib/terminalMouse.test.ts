import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { healMouseTracking, MOUSE_REPORT_OFF } from "./terminalMouse";

/** 只造 healMouseTracking 用到的两个成员：modes.mouseTrackingMode 与 write。 */
function fakeTerm(mode: "none" | "x10" | "vt200" | "drag" | "any"): Terminal {
  return {
    modes: { mouseTrackingMode: mode },
    write: vi.fn(),
  } as unknown as Terminal;
}

describe("healMouseTracking", () => {
  it("mode 为 none 时零写入", () => {
    const term = fakeTerm("none");
    healMouseTracking(term);
    expect(term.write).not.toHaveBeenCalled();
  });

  it("mode 为 any 时写 MOUSE_REPORT_OFF（重连乱码报障的残留态）", () => {
    const term = fakeTerm("any");
    healMouseTracking(term);
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledWith(MOUSE_REPORT_OFF);
  });

  it("x10 / vt200 / drag 同样治愈", () => {
    for (const mode of ["x10", "vt200", "drag"] as const) {
      const term = fakeTerm(mode);
      healMouseTracking(term);
      expect(term.write).toHaveBeenCalledWith(MOUSE_REPORT_OFF);
    }
  });

  it("MOUSE_REPORT_OFF 覆盖 SGR 编码与三种追踪模式", () => {
    expect(MOUSE_REPORT_OFF).toContain("\x1b[?1006l");
    expect(MOUSE_REPORT_OFF).toContain("\x1b[?1003l");
    expect(MOUSE_REPORT_OFF).toContain("\x1b[?1002l");
    expect(MOUSE_REPORT_OFF).toContain("\x1b[?1000l");
  });
});
