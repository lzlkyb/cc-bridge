// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionIssue } from "./ConnectionIssue";
import { ReadingOptions } from "./ReadingOptions";
import { RunControls } from "./RunControls";
import { useCcSendQueue } from "../../hooks/useCcSendQueue";
import { useComposerPolish } from "../../hooks/useComposerPolish";
import { SessionSidebar } from "./SessionSidebar";
import { CHAT_TYPOGRAPHY } from "../../lib/chatTypography";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
function render(node: ReactNode) { act(() => root.render(node)); }
function click(label: string) { const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); expect(button).toBeTruthy(); act(() => button!.click()); }

it("阅读档位为 14/15/16px，菜单保持完整标签", () => {
  expect(Object.values(CHAT_TYPOGRAPHY).map(v => v.px)).toEqual(["14px", "15px", "16px"]);
  render(<ReadingOptions />); click("阅读选项");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("舒适"); expect(dialog.textContent).toContain("精简");
  expect(dialog.querySelectorAll('[role="group"]')).toHaveLength(2);
});

it("模型菜单选择下一轮模型并关闭", () => {
  const change = vi.fn(); render(<RunControls model="opus" mode="default" onModelChange={change} onModeChange={() => {}} />);
  click("选择模型"); const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.includes("Sonnet"))!;
  act(() => button.click()); expect(change).toHaveBeenCalledWith("sonnet"); expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("错误合并展示但完整保留不同诊断，重试可见", () => {
  const retry = vi.fn(); render(<ConnectionIssue errors={["Permission denied", "model unavailable"]} stderr={["Permission denied", "host key changed"]} unavailable onRetry={retry} onDismiss={() => {}} />);
  expect(host.querySelectorAll("section")).toHaveLength(1); expect(host.querySelector("pre")?.textContent).toContain("host key changed");
  expect(host.querySelector("pre")?.textContent?.match(/Permission denied/g)).toHaveLength(1);
  act(() => [...host.querySelectorAll("button")].find(b => b.textContent === "重新检查环境")!.click()); expect(retry).toHaveBeenCalledTimes(1);
});

it("只有一条会话时搜索和新建仍可见，折叠后新建可达", () => {
  const onNew = vi.fn(); const props = { entries: [{ key: "p1", meta: null, restore: { kind: "none" as const } }], active: "p1", targets: [], stored: [], archived: false, archivedCount: 0, onToggleCollapsed: () => {}, onToggleArchived: () => {}, onPick: () => {}, onNew, onClose: () => {}, onOpenStored: () => {}, actions: { rename: async () => {}, archive: async () => {}, archived: {} } };
  render(<SessionSidebar {...props} collapsed={false} />); expect(host.querySelector('input[type="search"]')).toBeTruthy();
  expect(host.textContent).toContain("新对话"); render(<SessionSidebar {...props} collapsed />); click("新对话"); expect(onNew).toHaveBeenCalledTimes(1);
});

it("队列按稳定身份编辑，已出队条目不会修改后续消息", () => {
  let queue!: ReturnType<typeof useCcSendQueue>;
  function Harness() { queue = useCcSendQueue(); return null; } render(<Harness />);
  act(() => { queue.enqueue({ text: "一", images: [] }); queue.enqueue({ text: "二", images: [] }); });
  const first = queue.queue[0].id, second = queue.queue[1].id;
  act(() => { queue.take(); }); let accepted = true; act(() => { accepted = queue.edit(first, "旧编辑"); });
  expect(accepted).toBe(false); expect(queue.queue[0].text).toBe("二");
  act(() => { queue.edit(second, "修改第二条"); queue.pause(); queue.enqueue({ text: "三", images: [] }); });
  expect(queue.hasPausedItems()).toBe(true); expect(queue.queue.map(m => m.text)).toEqual(["修改第二条", "三"]);
  act(() => queue.remove(second)); expect(queue.queue.map(m => m.text)).toEqual(["三"]);
});

it("润色结果是候选稿，编辑后的迟到结果不覆盖新草稿", async () => {
  let resolve!: (value: string) => void;
  const polish = vi.fn(() => new Promise<string>(r => { resolve = r; }));
  let state!: ReturnType<typeof useComposerPolish>;
  function Harness() { state = useComposerPolish(polish); return null; } render(<Harness />);
  let pending!: Promise<void>; act(() => { pending = state.run("原稿"); }); act(() => state.reset());
  await act(async () => { resolve("迟到结果"); await pending; }); expect(state.preview).toBeNull();
  act(() => { pending = state.run("新草稿"); }); await act(async () => { resolve("建议稿"); await pending; });
  expect(state.preview).toEqual({ source: "新草稿", text: "建议稿" });
});
