import { afterEach, describe, expect, it, vi } from "vitest";
import { setTmuxBridgeEnabled } from "./terminalPreset";
import {
  envInjectCmd,
  formatUptime,
  hookCmd,
  isSupportedShell,
  parseOsc7,
  parseOsc133,
  parseOsc1337,
  shortenPath,
  tmuxBridgeCmd,
} from "./terminalStatusbar";

describe("会话环境注入（envInjectCmd / tmuxBridgeCmd / hookCmd）", () => {
  // `getStoredTheme()` 直读 localStorage 且没有 try/catch，node 测试环境必须给它替身。
  const withTheme = (theme: "dark" | "light") =>
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (k === "theme" ? theme : null),
      setItem: () => {},
    });

  afterEach(() => {
    vi.unstubAllGlobals();
    setTmuxBridgeEnabled(false); // 复位，避免污染同文件其它用例
  });

  it("暗色主题导出 COLORFGBG='15;0'", () => {
    withTheme("dark");
    expect(envInjectCmd()).toContain("COLORFGBG='15;0'");
  });

  it("亮色主题导出 COLORFGBG='0;15'", () => {
    withTheme("light");
    expect(envInjectCmd()).toContain("COLORFGBG='0;15'");
  });

  it("注入滚轮步长与「关掉远端在场检查」两项", () => {
    withTheme("dark");
    const c = envInjectCmd();
    expect(c).toContain("CLAUDE_CODE_SCROLL_SPEED=");
    // 远端那层「在场就不通知」与我们这层静默叠加会漏通知，必须关掉远端那份。
    expect(c).toContain("CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK='1'");
  });

  it("tmux 桥接命令带 $TMUX 守卫 + 三条全局设置，且以 fi 收尾", () => {
    const c = tmuxBridgeCmd();
    expect(c).toContain('if [ -n "$TMUX" ]');
    expect(c).toContain("set -g allow-passthrough on");
    expect(c).toContain("set -s extended-keys on");
    expect(c).toContain("set -as terminal-features 'xterm*:extkeys'");
    expect(c.trimEnd().endsWith("fi;")).toBe(true);
  });

  it("hookCmd 默认（tmux 桥接关）含环境注入与钩子定义、不含 tmux 注入", () => {
    withTheme("dark");
    const c = hookCmd();
    expect(c).toContain("export COLORFGBG");
    expect(c).not.toContain("allow-passthrough");
    expect(c).toContain("__ccb_p(){");
    expect(c).toContain("PROMPT_COMMAND");
  });

  it("提示符钩子同时发 133;D 与 133;A，且 D 在 A 之前", () => {
    withTheme("dark");
    const c = hookCmd();
    // 🔴 只发 D 不发 A 会让 terminalCommandNav（导航 + 耗时 + 命令块）整条链路失效。
    // 2026-10-13 修复：此前钩子只发 D，navCmdStart 从未被触发过。
    const iD = c.indexOf("]133;D;");
    const iA = c.indexOf("]133;A");
    expect(iD).toBeGreaterThan(-1);
    expect(iA).toBeGreaterThan(-1);
    // 顺序不能换：D 回填「刚跑完的那一块」，A 钉「下一块的起点」。
    expect(iD).toBeLessThan(iA);
  });

  it("hookCmd 在 tmux 桥接开启时插入 tmux 注入", () => {
    withTheme("dark");
    setTmuxBridgeEnabled(true);
    expect(hookCmd()).toContain("allow-passthrough");
  });
});

// xterm 的 `parser.registerOscHandler(ident, cb)` 回调收到的 data 是 ident **之后**的内容
// （**不含**首个 `;`），与 ident 本身无关。实证：`ESC]7;file://h/p` → data=`file://h/p`。

describe("parseOsc7（cwd）", () => {
  it("标准 file:// 路径", () => {
    expect(parseOsc7("file://host/home/me/app")).toBe("/home/me/app");
  });
  it("根目录", () => {
    expect(parseOsc7("file://host/")).toBe("/");
  });
  it("含空格/特殊字符的 URL 编码路径", () => {
    expect(parseOsc7("file://host/opt/my%20app")).toBe("/opt/my app");
  });
  it("非 file:// 返回 null", () => {
    expect(parseOsc7("http://evil")).toBeNull();
    expect(parseOsc7("/home/me")).toBeNull();
  });
});

describe("parseOsc133（退出码）", () => {
  it("D;<code> 解析退出码", () => {
    expect(parseOsc133("D;0")).toBe(0);
    expect(parseOsc133("D;137")).toBe(137);
  });
  it("只认 D 段，C（命令开始）不解析", () => {
    expect(parseOsc133("C")).toBeNull();
    expect(parseOsc133("A")).toBeNull();
  });
  it("缺退出码或非法值返回 null", () => {
    expect(parseOsc133("D;")).toBeNull();
    expect(parseOsc133("D;abc")).toBeNull();
  });
});

describe("parseOsc1337（私有键值）", () => {
  it("探针回执 Shell=", () => {
    expect(parseOsc1337("Shell=-bash")).toEqual({ shell: "-bash" });
  });
  it("git 分支 Git=", () => {
    expect(parseOsc1337("Git=main")).toEqual({ git: "main" });
    expect(parseOsc1337("Git=feature/login")).toEqual({ git: "feature/login" });
  });
  it("其它键忽略", () => {
    expect(parseOsc1337("Foo=bar")).toEqual({});
    expect(parseOsc1337("no-equals-sign")).toEqual({});
  });
});

describe("isSupportedShell（钩子注入门禁）", () => {
  it("bash/zsh 支持，登录 shell 的 - 前缀剥掉", () => {
    expect(isSupportedShell("bash")).toBe(true);
    expect(isSupportedShell("zsh")).toBe(true);
    expect(isSupportedShell("-bash")).toBe(true);
    expect(isSupportedShell("-zsh")).toBe(true);
  });
  it("fish/csh/tcsh/ksh/sh 一律不支持（盲发会喷语法错误）", () => {
    expect(isSupportedShell("fish")).toBe(false);
    expect(isSupportedShell("csh")).toBe(false);
    expect(isSupportedShell("tcsh")).toBe(false);
    expect(isSupportedShell("ksh")).toBe(false);
    expect(isSupportedShell("sh")).toBe(false);
    expect(isSupportedShell("dash")).toBe(false);
    expect(isSupportedShell("pwsh")).toBe(false);
  });
  it("宽容处理：首尾空白与大小写", () => {
    expect(isSupportedShell(" bash ")).toBe(true);
    expect(isSupportedShell("BASH")).toBe(true);
    expect(isSupportedShell("Fish")).toBe(false);
  });
  it("空串/畸形值不支持", () => {
    expect(isSupportedShell("")).toBe(false);
    expect(isSupportedShell("-")).toBe(false);
  });
});

describe("shortenPath", () => {
  it("短路径原样返回", () => {
    expect(shortenPath("/home/me")).toBe("/home/me");
  });
  it("超过 keep 层截断为 …/ 前缀", () => {
    expect(shortenPath("/a/b/c/d/e", 3)).toBe("…/c/d/e");
  });
  it("空串返回空串", () => {
    expect(shortenPath("")).toBe("");
  });
});

describe("formatUptime", () => {
  it("秒级", () => {
    expect(formatUptime(5_000)).toBe("5s");
    expect(formatUptime(59_000)).toBe("59s");
  });
  it("分钟级", () => {
    expect(formatUptime(60_000)).toBe("1m");
    expect(formatUptime(59 * 60_000 + 59_000)).toBe("59m");
  });
  it("小时级补零", () => {
    expect(formatUptime(65 * 60_000 + 3_000)).toBe("1h05m");
  });
  it("负值夹到 0", () => {
    expect(formatUptime(-100)).toBe("0s");
  });
});
