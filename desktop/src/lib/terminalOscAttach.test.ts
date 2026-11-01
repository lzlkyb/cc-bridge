import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { attachOscHandlers, type OscBridgeHooks } from "./terminalOscAttach";

/** 只实现被测代码真正用到的端子集：parser 注册表 + onData。 */
function fakeTerm() {
  const oscs = new Map<number, (d: string) => boolean>();
  let onData: ((d: string) => void) | null = null;
  const term = {
    buffer: { active: { type: "normal", cursorY: 0, getLine: () => null } },
    parser: {
      registerOscHandler: (code: number, cb: (d: string) => boolean) => {
        oscs.set(code, cb);
        return { dispose: () => oscs.delete(code) };
      },
    },
    onData: (cb: (d: string) => void) => {
      onData = cb;
      return { dispose: () => (onData = null) };
    },
    registerMarker: () => ({ dispose: () => undefined, onDispose: () => undefined, line: 0 }),
    get rows() {
      return 24;
    },
  } as unknown as Terminal;
  return {
    term,
    /** 模拟远端发来一个 OSC；返回 handler 的「已消费」结论。 */
    osc: (code: number, data: string) => oscs.get(code)?.(data),
    type: (data: string) => onData?.(data),
  };
}

function hooks(over: Partial<OscBridgeHooks> = {}): OscBridgeHooks {
  return {
    enabled: () => true,
    onCwd: vi.fn(),
    onCommandStart: vi.fn(),
    onCommandEnd: vi.fn(),
    onBranch: vi.fn(),
    onProbeOk: vi.fn(),
    onProbeUnsupported: vi.fn(),
    onUserInput: vi.fn(),
    ...over,
  };
}

describe("attachOscHandlers", () => {
  it("关闭注入时所有 OSC 被吞掉且不回调", () => {
    const { term, osc } = fakeTerm();
    const h = hooks({ enabled: () => false });
    attachOscHandlers(term, h);
    expect(osc(7, "file://host/home/u")).toBe(true);
    expect(osc(133, "D;0")).toBe(true);
    expect(osc(1337, "Shell=bash")).toBe(true);
    expect(h.onCwd).not.toHaveBeenCalled();
    expect(h.onCommandEnd).not.toHaveBeenCalled();
    expect(h.onProbeOk).not.toHaveBeenCalled();
  });

  it("OSC 7 → onCwd，解析不出目录时不回调", () => {
    const { term, osc } = fakeTerm();
    const h = hooks();
    attachOscHandlers(term, h);
    osc(7, "file://host/home/u");
    expect(h.onCwd).toHaveBeenCalledWith("/home/u");
    osc(7, "garbage");
    expect(h.onCwd).toHaveBeenCalledTimes(1);
  });

  it("🔴 探针回执按 shell 分流：fish 必须走「不支持」而不是注入钩子", () => {
    const { term, osc } = fakeTerm();
    const h = hooks();
    attachOscHandlers(term, h);
    osc(1337, "Shell=fish");
    expect(h.onProbeUnsupported).toHaveBeenCalledWith("fish");
    expect(h.onProbeOk).not.toHaveBeenCalled();
    osc(1337, "Shell=-bash"); // 登录 shell 带前导 -
    expect(h.onProbeOk).toHaveBeenCalledWith("-bash");
  });

  it("133;A 起命令、133;D 结束并带回退出码", () => {
    const { term, osc } = fakeTerm();
    const h = hooks();
    attachOscHandlers(term, h);
    osc(133, "A");
    expect(h.onCommandStart).toHaveBeenCalled();
    osc(133, "D;2");
    expect(h.onCommandEnd).toHaveBeenCalledWith(2, expect.anything());
  });

  it("任意按键都上报 onUserInput（含粘贴）", () => {
    const { term, type } = fakeTerm();
    const h = hooks();
    attachOscHandlers(term, h);
    type("l");
    type("s\t");
    expect(h.onUserInput).toHaveBeenNthCalledWith(1, "l");
    expect(h.onUserInput).toHaveBeenNthCalledWith(2, "s\t");
  });

  it("dispose 后不再有任何回调", () => {
    const { term, osc } = fakeTerm();
    const h = hooks();
    const dispose = attachOscHandlers(term, h);
    dispose();
    // 注册表已被摘掉：拿不到 handler = 不会再回调
    expect(osc(1337, "Shell=bash")).toBeUndefined();
    expect(h.onProbeOk).not.toHaveBeenCalled();
  });
});
