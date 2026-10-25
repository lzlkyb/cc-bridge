// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryPanel } from "./HistoryPanel";
import type { CcHistoryList, CcHistoryRow } from "../../lib/ccEventTypes";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: h.invoke }));

/**
 * 锁搜索这条链路的接线：输入 → 防抖 → 带 query 的 invoke → 命中高亮 → 空态。
 * 匹配口径本身在 ccHighlight.test.ts（前端）与 index.rs 的测试（Rust）里。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;

function row(sessionId: string, title: string, preview: string | null): CcHistoryRow {
  return {
    connectionId: "",
    sessionId,
    path: `/p/${sessionId}.jsonl`,
    cwd: "/proj",
    gitBranch: null,
    title,
    preview,
    messageCount: 3,
    fileSize: 100,
    fileMtimeMs: 1000,
    lastUsedAt: 1000,
    cached: false,
  };
}

const ALL: CcHistoryList = {
  rows: [row("a", "修复登录页的样式", "第二段：端口转发的那些事儿"), row("b", "终端配色方案", null)],
  failed: 0,
  dirFound: true,
  tookMs: 12,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.clearAllMocks();
  // 站台替身：按 query 过滤（整串包含对本测试用的查询与 trigram 同解）。
  h.invoke.mockImplementation(async (_cmd: string, args?: { query?: string }) => {
    const q = args?.query ?? "";
    if (q === "") return ALL;
    return { ...ALL, rows: ALL.rows.filter((r) => `${r.title}${r.preview ?? ""}`.includes(q)) };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(onClose: () => void = vi.fn()) {
  await act(async () => {
    root.render(<HistoryPanel onOpen={vi.fn()} onClose={onClose} />);
  });
  // 首次加载走 setTimeout(0)：等它跑完并落定。
  await act(async () => {
    await sleep(20);
  });
}

async function type(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("打开即加载全部，标题、摘要、计数都在", async () => {
  await mount();
  expect(h.invoke).toHaveBeenCalledWith("cc_history_list", { query: "" });
  expect(container.textContent).toContain("修复登录页的样式");
  expect(container.textContent).toContain("端口转发的那些事儿");
  expect(container.textContent).toContain("2 条 · 12ms");
});

it("输入防抖 150ms 后才带关键词重查", async () => {
  await mount();
  await type("修复");
  expect(h.invoke).toHaveBeenCalledTimes(1);
  await act(async () => {
    await sleep(200);
  });
  expect(h.invoke).toHaveBeenLastCalledWith("cc_history_list", { query: "修复" });
  expect(container.textContent).toContain("命中 1 条");
  expect(container.textContent).not.toContain("终端配色方案");
});

it("命中的片段涂成 mark", async () => {
  await mount();
  await type("修复");
  await act(async () => {
    await sleep(200);
  });
  expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["修复"]);
});

it("没有命中时给的是提示而不是白屏", async () => {
  await mount();
  await type("不存在");
  await act(async () => {
    await sleep(200);
  });
  expect(container.textContent).toContain("没有匹配「不存在」的会话");
  expect(container.textContent).toContain("3 字片段");
});

it("清空搜索恢复全部", async () => {
  await mount();
  await type("修复");
  await act(async () => {
    await sleep(200);
  });
  expect(h.invoke).toHaveBeenCalledTimes(2);
  const clear = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "清空搜索",
  )!;
  await act(async () => {
    clear.click();
  });
  await act(async () => {
    await sleep(20);
  });
  expect(h.invoke).toHaveBeenLastCalledWith("cc_history_list", { query: "" });
  expect(container.textContent).toContain("2 条");
});

it("Esc 关面板（含焦点在搜索框里时）", async () => {
  const onClose = vi.fn();
  await mount(onClose);
  // 搜索框 autoFocus，事件从它身上冒泡到 document——正是真实按 Esc 的路径。
  const input = container.querySelector("input")!;
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});
