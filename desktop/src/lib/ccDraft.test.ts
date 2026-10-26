// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DRAFT_MAX, clearDraft, pruneDrafts, readDraft, writeDraft } from "./ccDraft";

const KEY = (pane: string) => `ccbridge_composer_draft:${pane}`;

beforeEach(() => {
  localStorage.clear();
});

describe("输入框草稿的存取", () => {
  it("写进去能原样读回来", () => {
    writeDraft("p1", "帮我看看这个报错\n第二行");
    expect(readDraft("p1")).toBe("帮我看看这个报错\n第二行");
  });

  it("没存过 / 别的 pane 的草稿读出来是空串", () => {
    writeDraft("p1", "甲");
    expect(readDraft("p2")).toBe("");
  });

  /// 发送成功后会 `setValue("")`，那条路径必须**删键**而不是留一个空字符串，
  /// 否则每开一个会话就在 localStorage 里留一个空条目。
  it("写空串等于删除这条键", () => {
    writeDraft("p1", "写了一半");
    writeDraft("p1", "");
    expect(localStorage.getItem(KEY("p1"))).toBeNull();
    expect(readDraft("p1")).toBe("");
  });

  /// 🔴 超长时**不存**而不是截断存：截断会让用户重开时看到「我写的一段话少了
  ///    后半截」，那看着像程序吞了数据；不存至少是「草稿没保住」这个干净的结论。
  it("超过上限整条不存（不截断）", () => {
    writeDraft("p1", "x".repeat(DRAFT_MAX + 1));
    expect(readDraft("p1")).toBe("");
    // 恰好等于上限仍然存得下（边界不是「大于等于」）。
    writeDraft("p2", "y".repeat(DRAFT_MAX));
    expect(readDraft("p2")).toHaveLength(DRAFT_MAX);
  });

  it("clearDraft 只删这一条", () => {
    writeDraft("p1", "甲");
    writeDraft("p2", "乙");
    clearDraft("p1");
    expect(readDraft("p1")).toBe("");
    expect(readDraft("p2")).toBe("乙");
  });
});

describe("孤儿草稿清理", () => {
  /// 重启后窗口只剩 `p1`，而 `seq` 从 2 重来 —— 新窗口的 `p2` 会撞上一个窗口
  /// `p2` 的键。不清理的话用户新建第二条会话就看到别人的半句话。
  it("只保留当前窗口真实存在的 pane", () => {
    writeDraft("p1", "留");
    writeDraft("p2", "上一个窗口的");
    writeDraft("p3", "上一个窗口的");
    pruneDrafts(["p1"]);
    expect(readDraft("p1")).toBe("留");
    expect(readDraft("p2")).toBe("");
    expect(readDraft("p3")).toBe("");
  });

  /// 前缀之外的东西是别人的偏好（详情档位、diff 视图、发送键…），一个都不能碰。
  it("不碰前缀之外的 localStorage 键", () => {
    localStorage.setItem("ccbridge_chat_verbosity", "c");
    localStorage.setItem("unrelated", "keep-me");
    writeDraft("p9", "孤儿");
    pruneDrafts(["p1"]);
    expect(localStorage.getItem("ccbridge_chat_verbosity")).toBe("c");
    expect(localStorage.getItem("unrelated")).toBe("keep-me");
    expect(readDraft("p9")).toBe("");
  });

  it("幂等：同一份 keep 反复清结果一样", () => {
    writeDraft("p1", "留");
    pruneDrafts(["p1"]);
    pruneDrafts(["p1"]);
    expect(readDraft("p1")).toBe("留");
  });
});
