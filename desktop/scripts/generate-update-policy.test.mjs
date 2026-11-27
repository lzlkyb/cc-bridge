import { describe, expect, it } from "vitest";
import { buildPolicy, compareVersions, DEFAULT_GRACE_DAYS, parseVersion, signedPolicyDocument } from "./generate-update-policy.mjs";

/**
 * 锁的是「默认不强制」这条产品约定，以及三条会把用户锁死的错误配置。
 *
 * 发布侧写错策略的代价极高：min 高于最新版 ⇒ 所有人被挡在门外，且「更新到最新」
 * 也解除不了。客户端有 fail-open 兜底，但默认值和校验必须在构建期就挡住。
 */
describe("update-policy 版本解析与比较", () => {
  it("只接受三段数字，允许 v 前缀", () => {
    expect(parseVersion("3.5.0")).toEqual([3, 5, 0]);
    expect(parseVersion("v3.5.0")).toEqual([3, 5, 0]);
    expect(parseVersion("3.5")).toBeNull();
    expect(parseVersion("3.5.0-beta")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  it("按段比较而不是字符串排序", () => {
    expect(compareVersions("3.4.10", "3.4.9")).toBeGreaterThan(0);
    expect(compareVersions("3.10.0", "3.9.9")).toBeGreaterThan(0);
    expect(compareVersions("3.5.0", "3.5.0")).toBe(0);
    expect(compareVersions("oops", "3.5.0")).toBeNull();
  });
});

describe("buildPolicy", () => {
  const now = new Date("2026-11-26T00:00:00.000Z");

  it("默认不强制：没有 enforced 就是 false", () => {
    const p = buildPolicy({ version: "3.5.0", policy: {}, now });
    expect(p.enforced).toBe(false);
    expect(p.schema).toBe(1);
    // 不强制时 min 也写最新版，保证 min <= latest 恒成立。
    expect(p.minSupportedVersion).toBe("3.5.0");
    expect(p.latestVersion).toBe("3.5.0");
  });

  it("强制发版默认把 min 设成本次版本（所有人都得升上来）", () => {
    const p = buildPolicy({ version: "3.5.0", policy: { enforced: true }, now });
    expect(p.enforced).toBe(true);
    expect(p.minSupportedVersion).toBe("3.5.0");
  });

  it("可以只锁更低的门槛，让 3.4.2 及以上不受影响", () => {
    const p = buildPolicy({
      version: "3.5.0",
      policy: { enforced: true, minSupportedVersion: "3.4.2" },
      now,
    });
    expect(p.minSupportedVersion).toBe("3.4.2");
    expect(p.enforced).toBe(true);
  });

  it("缓冲期默认 1 天，从生成时刻起算", () => {
    const p = buildPolicy({ version: "3.5.0", policy: { enforced: true }, now });
    expect(DEFAULT_GRACE_DAYS).toBe(1);
    expect(p.graceUntil).toBe("2026-11-27T00:00:00.000Z");
  });

  it("graceDays=0 表示立即可锁", () => {
    const p = buildPolicy({ version: "3.5.0", policy: { enforced: true, graceDays: 0 }, now });
    expect(p.graceUntil).toBe(now.toISOString());
  });

  it("签署包含过期时间的完整策略，并让旧客户端跳过未知格式", () => {
    const policy = buildPolicy({ version: "3.5.0", policy: { enforced: true }, now });
    const document = signedPolicyDocument(policy, data => {
      expect(data).toBe("CC Bridge update policy v1\n" + JSON.stringify(policy));
      return " signature\n";
    });
    expect(document.signature).toBe("signature");
    expect(document.enforced).toBeUndefined();
    expect(policy.expiresAt).toBe("2026-12-04T00:00:00.000Z");
    expect(() => signedPolicyDocument(policy, () => "")).toThrow(/缺少签名/);
  });

  it("自定义说明原样保留，缺省时给一句人话", () => {
    const custom = buildPolicy({
      version: "3.5.0",
      policy: { enforced: true, message: "  修复了凭据泄露  " },
      now,
    });
    expect(custom.message).toBe("修复了凭据泄露");

    const fallback = buildPolicy({ version: "3.5.0", policy: { enforced: true }, now });
    expect(fallback.message).toContain("v3.5.0");
  });

  it("min 高于本次版本必须抛错（会把所有人锁死且无法解除）", () => {
    expect(() =>
      buildPolicy({ version: "3.5.0", policy: { enforced: true, minSupportedVersion: "9.9.9" }, now }),
    ).toThrow(/高于本次版本/);
  });

  it("非法版本号必须抛错", () => {
    expect(() => buildPolicy({ version: "3.5", policy: {}, now })).toThrow(/版本号不合法/);
    expect(() =>
      buildPolicy({ version: "3.5.0", policy: { minSupportedVersion: "v3.4" }, now }),
    ).toThrow(/minSupportedVersion 不合法/);
  });

  it("负数缓冲期必须抛错（否则会生成一个已过期的截止时间）", () => {
    expect(() =>
      buildPolicy({ version: "3.5.0", policy: { enforced: true, graceDays: -1 }, now }),
    ).toThrow(/不能为负/);
  });
});
