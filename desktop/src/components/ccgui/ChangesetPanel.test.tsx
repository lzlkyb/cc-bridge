// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangesetPanel } from "./ChangesetPanel";
import type { ChangesetEntry } from "../../lib/ccChangeset";

/**
 * 锁面板的两个对外行为：点条目把「第一处 diff 的消息 id」交出去（跳转的
 * 全部依据），Esc / 点外面能收起来。聚合口径的正确性在 ccChangeset.test.ts。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;

const entries: ChangesetEntry[] = [
  { path: "/repo/src/a.ts", label: "src/a.ts", edits: 2, failed: 0, created: false, messageId: "t1" },
  { path: "/repo/src/new.ts", label: "src/new.ts", edits: 1, failed: 1, created: true, messageId: "t2" },
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(list: ChangesetEntry[] = entries, onJump = vi.fn(), onClose = vi.fn()) {
  await act(async () => {
    root.render(<ChangesetPanel entries={list} onJump={onJump} onClose={onClose} />);
  });
  return { onJump, onClose };
}
function row(label: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;
}

it("列出文件、新建徽章、失败计数与汇总", async () => {
  await render();
  expect(container.textContent).toContain("2 个文件 · 3 处改动");
  expect(row("src/a.ts").textContent).toContain("×2");
  expect(row("src/new.ts").textContent).toContain("新建");
  expect(row("src/new.ts").textContent).toContain("1 败");
});

it("点条目把第一处 diff 的消息 id 交给跳转", async () => {
  const { onJump, onClose } = await render();
  await act(async () => row("src/a.ts").click());
  expect(onJump).toHaveBeenCalledWith("t1");
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => row("src/new.ts").click());
  expect(onJump).toHaveBeenCalledWith("t2");
});

it("Esc 与点外面都能收起", async () => {
  const { onClose } = await render();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("没有改动时给的是引导而不是空列表", async () => {
  await render([]);
  expect(container.textContent).toContain("还没有改过文件");
  expect(container.textContent).toContain("Edit / Write");
});
