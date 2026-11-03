import { describe, it, expect } from "vitest";
import { attentionState, tabAgentBadge, tabAgentMissingHint } from "./terminalTabAgent";
import type { ProgramStatus } from "./terminalProgramStatus";

/** 造一条上报：未给的字段一律 null（与 parseProgramStatus 的产出形状一致）。 */
function st(state: ProgramStatus["state"], extra: Partial<ProgramStatus> = {}): ProgramStatus {
  return { state, kind: null, app: "claude-code", title: null, msg: null, progress: null, ...extra };
}

describe("tabAgentBadge：状态 → 徽标", () => {
  it("working：转圈的 spinner，用信息色（teal），不是琥珀", () => {
    const b = tabAgentBadge(st("working", { progress: 40 }))!;
    expect(b.shape).toBe("spinner");
    expect(b.spin).toBe(true);
    expect(b.colorClass).toContain("teal");
    // 🔴 琥珀是 warn 的专属语义色，被 working 占掉之后「等确认」就不醒目了
    expect(b.colorClass).not.toContain("amber");
    expect(b.label).toBe("运行中 40%");
  });

  it("working 无 progress 时文案退化为「运行中」", () => {
    expect(tabAgentBadge(st("working"))!.label).toBe("运行中");
  });

  it("blocked：纯色圆点，琥珀填充（填充色而非文字色）", () => {
    const b = tabAgentBadge(st("blocked", { kind: "permission" }))!;
    expect(b.shape).toBe("dot");
    expect(b.spin).toBe(false);
    expect(b.colorClass).toContain("bg-amber");
    expect(b.label).toBe("等待确认");
  });

  it("blocked 三种 kind 各自成文案（它到底在等什么）", () => {
    expect(tabAgentBadge(st("blocked", { kind: "question" }))!.label).toBe("等待回答");
    expect(tabAgentBadge(st("blocked", { kind: "auth" }))!.label).toBe("等待登录");
    expect(tabAgentBadge(st("blocked"))!.label).toBe("已阻塞");
  });

  it("done：对勾，绿色，不转", () => {
    const b = tabAgentBadge(st("done"))!;
    expect(b.shape).toBe("check");
    expect(b.spin).toBe(false);
    expect(b.colorClass).toContain("green");
  });

  it("error：警告三角，用 destructive-ink（小字/小图标在亮色底可读的变体）", () => {
    const b = tabAgentBadge(st("error"))!;
    expect(b.shape).toBe("alert");
    expect(b.colorClass).toBe("text-destructive-ink");
  });

  it("idle / clear / 从未上报：一律不显示", () => {
    expect(tabAgentBadge(st("idle"))).toBeNull();
    expect(tabAgentBadge(st("clear"))).toBeNull();
    expect(tabAgentBadge(null)).toBeNull();
  });

  it("tooltip 带上程序名与它上报的正文（它在问什么）", () => {
    const b = tabAgentBadge(st("blocked", { kind: "permission", msg: "允许写入 /etc/nginx 吗？" }))!;
    expect(b.tooltip).toContain("claude-code");
    expect(b.tooltip).toContain("等待确认");
    expect(b.tooltip).toContain("允许写入 /etc/nginx 吗？");
  });
});

describe("attentionState：谁算「需要你看一眼」", () => {
  it("blocked / done / error 算", () => {
    expect(attentionState("blocked")).toBe(true);
    expect(attentionState("done")).toBe(true);
    expect(attentionState("error")).toBe(true);
  });

  it("🔴 working 不算：转圈本身就在表达在干活，算进来会让每个后台在跑的标签都变未读", () => {
    expect(attentionState("working")).toBe(false);
  });

  it("idle / clear 不算：安静待命不该打扰", () => {
    expect(attentionState("idle")).toBe(false);
    expect(attentionState("clear")).toBe(false);
  });

  it("徽标的 needsAttention 与它同源（渲染层据此决定要不要按已读降级）", () => {
    expect(tabAgentBadge(st("working"))!.needsAttention).toBe(false);
    expect(tabAgentBadge(st("blocked"))!.needsAttention).toBe(true);
    expect(tabAgentBadge(st("done"))!.needsAttention).toBe(true);
    expect(tabAgentBadge(st("error"))!.needsAttention).toBe(true);
  });
});

describe("tabAgentMissingHint：旧版 CC 弱提示", () => {
  it("有 OSC 标题却没有程序状态 → 追加提示（带前导换行，拼进 title 属性）", () => {
    const hint = tabAgentMissingHint(true, null);
    expect(hint.startsWith("\n")).toBe(true);
    expect(hint).toContain("OSC 7501");
  });

  it("有上报时不提示（不是旧版 CC，只是恰好 idle 也算有上报）", () => {
    expect(tabAgentMissingHint(true, st("idle"))).toBe("");
    expect(tabAgentMissingHint(true, st("working"))).toBe("");
  });

  it("纯 shell 标签（没有 OSC 标题）不提示：没有 CC 可报，加了是噪声", () => {
    expect(tabAgentMissingHint(false, null)).toBe("");
  });
});
