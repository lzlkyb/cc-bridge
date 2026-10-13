import { describe, it, expect } from "vitest";
import { riskLevel, type SecurityFlags } from "./riskLevel";

/** 构造一组开关状态；默认全关（最安全配置之外的常见组合逐个覆盖）。 */
function flags(over: Partial<SecurityFlags> = {}): SecurityFlags {
  return { whitelistEnabled: true, shellEnabled: false, readonlyMode: false, ...over };
}

describe("riskLevel", () => {
  it("全默认（白名单开、shell 关、可写）→ 有风险", () => {
    const v = riskLevel(flags());
    expect(v.level).toBe("warn");
    expect(v.label).toBe("有风险");
    expect(v.desc).toContain("可写状态");
  });

  it("只读压制下全开 → 较安全", () => {
    const v = riskLevel(flags({ readonlyMode: true }));
    expect(v.level).toBe("safe");
    expect(v.label).toBe("较安全");
  });

  it("白名单关（shell 关）→ 高风险 · 全文件", () => {
    const v = riskLevel(flags({ whitelistEnabled: false }));
    expect(v.level).toBe("high");
    expect(v.desc).toContain("全部文件");
  });

  it("shell 开 + 可写 → 高风险 · RCE", () => {
    const v = riskLevel(flags({ shellEnabled: true }));
    expect(v.level).toBe("high");
    expect(v.desc).toContain("RCE");
  });

  it("shell 开 + 只读 → 被压制，不算高风险（核心回归：两页结论必须一致）", () => {
    const v = riskLevel(flags({ shellEnabled: true, readonlyMode: true }));
    expect(v.level).toBe("safe");
  });

  it("shell 开 + 只读 + 白名单关 → 仍高风险（白名单独立成立），但描述走白名单分支", () => {
    const v = riskLevel(flags({ shellEnabled: true, readonlyMode: true, whitelistEnabled: false }));
    expect(v.level).toBe("high");
    expect(v.desc).toContain("全部文件");
  });

  it("shell 开 + 白名单关 + 可写 → 最高描述文案", () => {
    const v = riskLevel(flags({ shellEnabled: true, whitelistEnabled: false }));
    expect(v.desc).toContain("风险极高");
  });

  it("三档 pill / icon 成套返回", () => {
    expect(riskLevel(flags()).pill).toContain("warning");
    expect(riskLevel(flags({ readonlyMode: true })).icon).toBe("check");
    expect(riskLevel(flags({ whitelistEnabled: false })).icon).toBe("alertTriangle");
  });
});
