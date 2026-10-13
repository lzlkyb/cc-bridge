import { describe, it, expect } from "vitest";
import {
  PROGRAM_STATUS_PROBE_REPLY,
  isProgramStatusProbe,
  decodeBase64Utf8,
  parseProgramStatus,
  programStateLabel,
  programStateTitle,
  blockedNotice,
  themeNotifyReport,
  csiParamHasMode,
} from "./terminalProgramStatus";

describe("OSC 7501 探测", () => {
  it("payload 为 `?` 时判为探测（xterm 给的是 ident 之后、不含首个分号的内容）", () => {
    expect(isProgramStatusProbe("?")).toBe(true);
  });
  it("状态上报不会被误判成探测", () => {
    expect(isProgramStatusProbe("state=working")).toBe(false);
    expect(isProgramStatusProbe("?state=working")).toBe(false);
  });
  it("应答是同形序列且以 `?` 开头（Claude Code 只认这个）", () => {
    expect(PROGRAM_STATUS_PROBE_REPLY).toBe("\x1b]7501;?\x1b\\");
  });
});

describe("decodeBase64Utf8", () => {
  it("ASCII", () => {
    expect(decodeBase64Utf8("SGVsbG8=")).toBe("Hello");
  });
  it("中文按 UTF-8 还原（直接 atob 会乱码）", () => {
    expect(decodeBase64Utf8("5Lit5paH")).toBe("中文");
  });
  it("非法 base64 返回 null，不抛", () => {
    expect(decodeBase64Utf8("!!!not-base64!!!")).toBeNull();
  });
});

describe("parseProgramStatus", () => {
  it("完整上报：state/kind/app/msg", () => {
    const p = parseProgramStatus("state=blocked:kind=permission:app=claude-code:msg=5Lit5paH");
    expect(p).not.toBeNull();
    expect(p!.state).toBe("blocked");
    expect(p!.kind).toBe("permission");
    expect(p!.app).toBe("claude-code");
    expect(p!.msg).toBe("中文");
  });
  it("只有 state 的最简上报也成立", () => {
    const p = parseProgramStatus("state=working");
    expect(p!.state).toBe("working");
    expect(p!.kind).toBeNull();
    expect(p!.app).toBeNull();
    expect(p!.msg).toBeNull();
  });
  it("base64 的补位 `=` 不会被当成第二个分隔符截断", () => {
    expect(parseProgramStatus("state=done:msg=SGVsbG8=")!.msg).toBe("Hello");
  });
  it("缺 state → null（规范要求拒绝非法上报）", () => {
    expect(parseProgramStatus("msg=5Lit5paH")).toBeNull();
    expect(parseProgramStatus("")).toBeNull();
  });
  it("state 非法 → null", () => {
    expect(parseProgramStatus("state=bogus")).toBeNull();
  });
  it("kind 非法 → 置 null，但整条仍可用", () => {
    const p = parseProgramStatus("state=blocked:kind=whatever");
    expect(p!.state).toBe("blocked");
    expect(p!.kind).toBeNull();
  });
  it("progress 解析并夹到 0–100", () => {
    expect(parseProgramStatus("state=working:progress=40")!.progress).toBe(40);
    expect(parseProgramStatus("state=working:progress=140")!.progress).toBe(100);
    expect(parseProgramStatus("state=working:progress=-3")!.progress).toBe(0);
    expect(parseProgramStatus("state=working:progress=abc")!.progress).toBeNull();
  });
  it("clear 是合法值（删记录），title 也走 base64", () => {
    const p = parseProgramStatus("state=clear:title=5Lit5paH");
    expect(p!.state).toBe("clear");
    expect(p!.title).toBe("中文");
  });
  it("未知键忽略，不影响其它字段", () => {
    expect(parseProgramStatus("state=idle:foo=bar:app=x")!.app).toBe("x");
  });
});

describe("programStateLabel", () => {
  const mk = (s: string, k: string | null = null, progress: number | null = null) =>
    parseProgramStatus(`state=${s}${k ? `:kind=${k}` : ""}${progress !== null ? `:progress=${progress}` : ""}`)!;

  it("working：有进度带百分比", () => {
    expect(programStateLabel(mk("working", null, 40))).toBe("运行中 40%");
    expect(programStateLabel(mk("working"))).toBe("运行中");
  });
  it("blocked 按 kind 细分", () => {
    expect(programStateLabel(mk("blocked", "permission"))).toBe("等待确认");
    expect(programStateLabel(mk("blocked", "question"))).toBe("等待回答");
    expect(programStateLabel(mk("blocked", "auth"))).toBe("等待登录");
    expect(programStateLabel(mk("blocked"))).toBe("已阻塞");
  });
  it("done / error 显示", () => {
    expect(programStateLabel(mk("done"))).toBe("已完成");
    expect(programStateLabel(mk("error"))).toBe("出错");
  });
  it("idle / clear 不显示（安静待命不该常驻一行）", () => {
    expect(programStateLabel(mk("idle"))).toBeNull();
    expect(programStateLabel(mk("clear"))).toBeNull();
  });
});

describe("programStateTitle", () => {
  it("带 msg 时把「它在问什么」补进悬停说明", () => {
    const p = parseProgramStatus("state=blocked:kind=permission:app=claude-code:msg=SGVsbG8=")!;
    const t = programStateTitle(p, "等待确认");
    expect(t).toContain("claude-code");
    expect(t).toContain("Hello");
  });
});

describe("blockedNotice", () => {
  it("blocked:permission → 通知，标题点明要确认", () => {
    const p = parseProgramStatus("state=blocked:kind=permission:app=claude-code:msg=SGVsbG8=")!;
    const n = blockedNotice(p, "myhost");
    expect(n).not.toBeNull();
    expect(n!.title).toContain("myhost");
    expect(n!.title).toContain("确认");
    expect(n!.body).toBe("Hello");
  });
  it("blocked 无 msg → 用兜底正文", () => {
    const p = parseProgramStatus("state=blocked:kind=permission")!;
    expect(blockedNotice(p, "h")!.body.length).toBeGreaterThan(0);
  });
  it("working / done / idle 都不通知（done 由 MCP push_notification 负责，避免重复打扰）", () => {
    expect(blockedNotice(parseProgramStatus("state=working")!, "h")).toBeNull();
    expect(blockedNotice(parseProgramStatus("state=done")!, "h")).toBeNull();
    expect(blockedNotice(parseProgramStatus("state=idle")!, "h")).toBeNull();
  });
});

describe("DEC 2031 主题上报", () => {
  // 逐字节断言：Claude Code 的解析正则是 `^\x1b\[\?997;([12])n$`，**只认** 1 与 2。
  it("深色 → 997;1，亮色 → 997;2", () => {
    expect(themeNotifyReport(true)).toBe("\x1b[?997;1n");
    expect(themeNotifyReport(false)).toBe("\x1b[?997;2n");
  });
});

describe("csiParamHasMode", () => {
  it("扁平参数", () => {
    expect(csiParamHasMode([2031], 2031)).toBe(true);
    expect(csiParamHasMode([1000, 1006], 1006)).toBe(true);
    expect(csiParamHasMode([1000, 1006], 2031)).toBe(false);
  });
  it("子参数数组", () => {
    expect(csiParamHasMode([[2031, 5]], 2031)).toBe(true);
    expect(csiParamHasMode([[2031, 5]], 7)).toBe(false);
  });
  it("空数组", () => {
    expect(csiParamHasMode([], 2031)).toBe(false);
  });
});
