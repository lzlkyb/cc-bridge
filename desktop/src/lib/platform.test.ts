import { describe, expect, it } from "vitest";

import {
  aboutCopy,
  dangerousCommandExample,
  isMac,
  isWindows,
  modKeyLabel,
  notifyCommandCompleteSub,
  releaseWebviewHint,
  shellTypeCopy,
  shortcutLabel,
} from "./platform";

describe("平台判定", () => {
  it("首帧（platform 为 undefined）两个判定都返回 false", () => {
    // 这是有意的取舍：宁可当成非 mac，也不要让 Windows 专属 UI 首帧闪现。
    expect(isWindows(undefined)).toBe(false);
    expect(isMac(undefined)).toBe(false);
  });

  it("只认 Rust std::env::consts::OS 的原值", () => {
    expect(isWindows("windows")).toBe(true);
    expect(isMac("macos")).toBe(true);
    // 常见写错：mac / darwin 都不是 Rust 的取值
    expect(isMac("mac")).toBe(false);
    expect(isMac("darwin")).toBe(false);
  });

  it("快捷键标签：mac 不带加号", () => {
    expect(modKeyLabel("macos")).toBe("⌘");
    expect(modKeyLabel("windows")).toBe("Ctrl");
    expect(shortcutLabel("macos", "K")).toBe("⌘K");
    expect(shortcutLabel("windows", "K")).toBe("Ctrl+K");
  });
});

describe("shellTypeCopy", () => {
  it("Windows 上默认项显示为 cmd、提 Git for Windows", () => {
    const c = shellTypeCopy("windows");
    expect(c.defaultLabel).toBe("cmd");
    expect(c.altNote).toContain("Git for Windows");
    expect(c.unavailableToast).toContain("Git for Windows");
  });

  it("mac 上默认项显示为 sh，且**不得出现 Git for Windows**", () => {
    // 这正是清单 N16 要修的问题：mac 用户看到「需本机已装 Git for Windows」。
    const c = shellTypeCopy("macos");
    expect(c.defaultLabel).toBe("sh");
    expect(c.altNote).not.toContain("Git for Windows");
    expect(c.unavailableToast).not.toContain("Git for Windows");
    expect(c.unavailableWarn).not.toContain("Git for Windows");
    expect(c.stillUnavailableToast).not.toContain("Git for Windows");
  });

  it("首帧（undefined）走非 Windows 分支，不会泄露 Windows 专属文案", () => {
    expect(shellTypeCopy(undefined).altNote).not.toContain("Git for Windows");
  });

  it("备选项显示名两平台都是 bash", () => {
    expect(shellTypeCopy("windows").altLabel).toBe("bash");
    expect(shellTypeCopy("macos").altLabel).toBe("bash");
  });
});

describe("releaseWebviewHint", () => {
  it("Windows 给 85MB → 6MB（多进程 WebView2 的口径）", () => {
    const h = releaseWebviewHint("windows");
    expect(h).toContain("85MB");
    expect(h).toContain("6MB");
    expect(h).not.toContain("120MB");
  });

  it("mac 给 120MB 并说明主进程常驻（WKWebView 在独立进程里）", () => {
    // 不能照搬 Windows 的 85MB：mac 实测是 WebContent 进程 121MB → 消失，
    // 而主进程几乎不变（约 22MB）。
    const h = releaseWebviewHint("macos");
    expect(h).toContain("120MB");
    expect(h).toContain("22MB");
    expect(h).not.toContain("85MB");
  });

  it("两平台都声明不影响 MCP 服务 / 托盘 / 通知", () => {
    for (const p of ["windows", "macos", undefined]) {
      expect(releaseWebviewHint(p)).toContain("MCP 服务");
      expect(releaseWebviewHint(p)).toContain("不受影响");
    }
  });
});

describe("notifyCommandCompleteSub", () => {
  it("Windows 说 toast，mac 说通知中心", () => {
    expect(notifyCommandCompleteSub("windows")).toContain("Windows toast");
    const mac = notifyCommandCompleteSub("macos");
    expect(mac).toContain("通知中心");
    expect(mac).not.toContain("Windows toast");
  });
});

describe("dangerousCommandExample", () => {
  it("举例必须是本平台真存在的路径", () => {
    expect(dangerousCommandExample("windows")).toBe("rm -rf C:\\Windows");
    // mac 上不能出现盘符路径，否则用户完全对不上号
    const mac = dangerousCommandExample("macos");
    expect(mac).not.toContain("C:\\");
    expect(mac).toContain("/");
  });
});

describe("aboutCopy", () => {
  it("Windows 保留 NSIS 安装包体积与 Job Object 口径", () => {
    const a = aboutCopy("windows");
    expect(a.stats.map((s) => s.val)).toContain("3.4 MB");
    expect(a.lightweight).toContain("3.4MB");
    expect(a.sandbox).toContain("Job Object");
  });

  it("mac 不得出现 3.4MB / <20MB / Job Object 这三个 Windows 口径", () => {
    // mac 没有安装程序（发布物是 .app.tar.gz），照搬这些数字就是编；
    // Job Object 更是 Windows 专属 API，mac 上是 POSIX 进程组。
    const a = aboutCopy("macos");
    const all = [a.lightweight, a.sandbox, ...a.stats.map((s) => `${s.val}${s.label}`)].join("|");
    expect(all).not.toContain("3.4");
    expect(all).not.toContain("20 MB");
    expect(all).not.toContain("Job Object");
    expect(a.sandbox).toContain("进程组");
  });

  it("首帧（undefined）落 Windows 文案，避免闪一下「免安装」这种错数字", () => {
    expect(aboutCopy(undefined).lightweight).toBe(aboutCopy("windows").lightweight);
  });

  it("统计格固定三个，MCP 工具数两平台一致", () => {
    expect(aboutCopy("windows").stats).toHaveLength(3);
    expect(aboutCopy("macos").stats).toHaveLength(3);
    expect(aboutCopy("macos").stats[2]).toEqual(aboutCopy("windows").stats[2]);
  });
});
