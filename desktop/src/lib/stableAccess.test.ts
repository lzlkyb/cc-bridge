import { describe, expect, it } from "vitest";
import { chooseStableTarget, stableNeedsLogin, type StableDiscovery, type StableTarget } from "./stableAccess";

const target: StableTarget = { id: "one", name: "cc-bridge", scope: "project", projectPath: "/work", projectKey: null,
  configFile: "/work/.mcp.json", url: "http://10.0.0.2:7823/mcp", fingerprint: "a".repeat(64), recognized: true, tokenMatches: false };
const result = (targets: StableTarget[], complete = true): StableDiscovery => ({ targets, complete, signature: "test", files: [], home: "/home/user", inspectedProjectPath: null, projects: [], warnings: [] });

describe("自动识别边界", () => {
  it("唯一已知名称可直接展示升级方案，Token 变化不改变原来的范围", () => {
    expect(chooseStableTarget(result([target]))).toBe(target);
  });
  it("多个接入、未知名称或读取不完整都需要先确认", () => {
    expect(chooseStableTarget(result([target, { ...target, id: "two" }]))).toBeUndefined();
    expect(chooseStableTarget(result([{ ...target, recognized: false, tokenMatches: true }]))).toBeUndefined();
    expect(chooseStableTarget(result([target], false), target.id)).toBeUndefined();
  });
  it("已明确选择或保存过的自定义接入可以继续使用", () => {
    const custom = { ...target, recognized: false };
    expect(chooseStableTarget(result([custom, { ...custom, id: "two" }]), custom.id)).toBe(custom);
  });
});

describe("临时登录恢复", () => {
  it.each([
    "需要登录服务器，请输入登录密码。", "需要密码", "Permission denied (publickey,password).",
    "Authentication failed", "解密密码失败：保存的信息无法读取", "解密密钥密码短语失败：保存的信息无法读取",
  ])("登录信息失效后提供临时输入：%s", message => {
    expect(stableNeedsLogin(message)).toBe(true);
  });
  it("读取密钥文件、网络和配置错误仍需对应修复", () => {
    for (const message of ["加载 SSH 密钥失败：文件不存在", "连接服务器超时", "配置文件无法读取"]) {
      expect(stableNeedsLogin(message)).toBe(false);
    }
  });
});
