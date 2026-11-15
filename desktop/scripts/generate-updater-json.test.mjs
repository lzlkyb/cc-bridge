import { describe, expect, it } from "vitest";
import { RAW_ANONYMOUS_LIMIT_BYTES, mirrorUrlTooLargeForRaw } from "./generate-updater-json.mjs";

/**
 * 钉的是 2026-11-15 回填 v3.1.5 时量出来的平台边界，不是拍脑袋的阈值：
 *   raw 上的 exe 8,086,364 B → 200
 *   raw 上的 mac tar.gz 10,729,915 B → 403 `large file require login for access`
 * 客户端没有登录态 ⇒ 清单指向 raw 上的大文件 = 那个平台永远装不上更新。
 */
describe("Gitee raw 匿名下载上限守卫", () => {
  const raw = (name) => `https://gitee.com/lzul/cc-bridge/raw/releases/latest/${name}`;
  const asset = (tag, name) => `https://gitee.com/lzul/cc-bridge/releases/download/${tag}/${name}`;
  const EXE_V315 = 8_086_364; // 实测 200
  const MAC_V315 = 10_729_915; // 实测 403

  it("实测通过的体积不误报", () => {
    expect(mirrorUrlTooLargeForRaw(raw("cc-bridge_3.1.5_x64-setup.exe"), EXE_V315)).toBe(false);
  });

  it("实测被 403 的体积必须报出来", () => {
    expect(mirrorUrlTooLargeForRaw(raw("cc-bridge.app.tar.gz"), MAC_V315)).toBe(true);
  });

  it("换到发行版附件后同样的体积不再受限（这才是正解）", () => {
    expect(mirrorUrlTooLargeForRaw(asset("v3.1.5", "cc-bridge.app.tar.gz"), MAC_V315)).toBe(false);
    expect(mirrorUrlTooLargeForRaw(asset("v3.1.5", "cc-bridge.app.tar.gz"), 300 * 1024 * 1024)).toBe(false);
  });

  it("GitHub / gh-proxy 路径不受这条限制影响", () => {
    expect(
      mirrorUrlTooLargeForRaw("https://gh-proxy.com/https://github.com/x/y/releases/download/v1/a.tar.gz", MAC_V315),
    ).toBe(false);
  });

  it("阈值落在实测区间内（8.08MB 通、10.23MB 不通）", () => {
    expect(RAW_ANONYMOUS_LIMIT_BYTES).toBeGreaterThan(EXE_V315);
    expect(RAW_ANONYMOUS_LIMIT_BYTES).toBeLessThan(MAC_V315);
  });
});
