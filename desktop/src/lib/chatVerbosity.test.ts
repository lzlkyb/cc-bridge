// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { CHAT_VERBOSITY, cycleChatVerbosity, setChatVerbosity } from "./chatVerbosity";

describe("chatVerbosity 档位", () => {
  beforeEach(() => {
    setChatVerbosity("n");
  });

  it("默认是标准档（不给老用户换默认）", () => {
    expect(CHAT_VERBOSITY.n.label).toBe("标准");
  });

  /// 按钮是「点一下就换一档」，顺序错了用户会以为点击没生效。
  it("循环顺序：详细 → 标准 → 精简 → 详细", () => {
    setChatVerbosity("v");
    expect(cycleChatVerbosity()).toBe("n");
    expect(cycleChatVerbosity()).toBe("c");
    expect(cycleChatVerbosity()).toBe("v");
  });

  it("写进 localStorage，跨重启仍然记得", () => {
    setChatVerbosity("c");
    expect(localStorage.getItem("ccbridge_chat_verbosity")).toBe("c");
  });

  it("三档都有给人看的标签与说明（按钮 title 直接用）", () => {
    for (const v of ["v", "n", "c"] as const) {
      expect(CHAT_VERBOSITY[v].label.length).toBeGreaterThan(0);
      expect(CHAT_VERBOSITY[v].hint.length).toBeGreaterThan(0);
    }
  });
});
