// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutionSummary } from "./ExecutionSummary";
import type { CcMessage } from "../../lib/ccGuiTypes";
import type { CcMark } from "../../lib/ccMarkdown";

/**
 * 「工具过程」分组的展开态（受控 `open` + `onToggle`）。
 *
 * 钉的是**复位时机**：`manuallyClosed` 必须在 `forced` 的**上升沿**清掉。
 * 曾经写成 `if (!forced) setManuallyClosed(false)`（下降沿），于是「用户先在无强制
 * 条件下手动收起 → 之后搜索命中」这条最常见的路径上，分组再也撑不开 —— 而注释
 * 写的是「强制条件消失再恢复」，行为与说明正好相反，且没有任何测试兜着。
 */

const toolMessage = (id: string): Extract<CcMessage, { kind: "tool" }> => ({
  kind: "tool",
  id,
  at: "",
  tool: { id, name: "Read", input: { file_path: "/a.ts" }, status: "ok", result: "ok" },
});

const marks = (id: string): Map<string, CcMark[]> => new Map([[id, [{ seg: 0, start: 0, end: 1 }]]]);

/** 外层持一个 `forced` 开关，模拟「搜索从无到有」。 */
function Harness() {
  const [hit, setHit] = useState(false);
  return createElement(
    "div",
    null,
    createElement("button", { id: "hit-on", onClick: () => setHit(true) }, "命中"),
    createElement("button", { id: "hit-off", onClick: () => setHit(false) }, "清空"),
    createElement(ExecutionSummary, {
      messages: [toolMessage("t1")],
      marksByMsg: hit ? marks("t1") : null,
    }),
  );
}

describe("ExecutionSummary 展开态", () => {
  let host: HTMLDivElement;
  let root: Root;
  const details = () => host.querySelector("details") as HTMLDetailsElement;
  const click = (id: string) =>
    act(() => {
      (host.querySelector(`#${id}`) as HTMLButtonElement).click();
    });
  const userToggle = (open: boolean) =>
    act(() => {
      details().open = open;
      details().dispatchEvent(new Event("toggle"));
    });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(Harness)));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("默认收起，搜索命中即撑开", () => {
    expect(details().open).toBe(false);
    click("hit-on");
    expect(details().open).toBe(true);
  });

  it("先在无强制条件下手动收起，之后搜索命中仍然撑得开", () => {
    userToggle(true);
    userToggle(false); // 用户「看一眼又收起来」
    click("hit-on");
    expect(details().open).toBe(true);
  });

  it("同一轮强制展开期间，用户手动收起被尊重（不再被抢着打开）", () => {
    click("hit-on");
    expect(details().open).toBe(true);
    userToggle(false);
    expect(details().open).toBe(false);
    // 命中条件没变（forced 保持为真），不该被重新撑开。
    click("hit-off");
    click("hit-on");
    expect(details().open).toBe(true);
  });
});
