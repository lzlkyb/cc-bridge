// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCcPaneList } from "./useCcPaneList";
import type { CcPaneMeta } from "../lib/ccPaneMeta";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: h.invoke }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let api: ReturnType<typeof useCcPaneList>, root: Root;
function Probe() {
  api = useCcPaneList();
  return null;
}

const meta = (sessionId: number | null, title = "会话"): CcPaneMeta => ({
  sessionId,
  title,
  turns: 1,
  state: "idle",
  detail: "1 轮 · 空闲",
  connectionId: "",
  targetLabel: "本机",
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.invoke.mockResolvedValue(true);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("侧栏会话列表", () => {
  it("初始只有一条，且它是当前会话", () => {
    expect(api.entries).toHaveLength(1);
    expect(api.active).toBe(api.entries[0].key);
  });

  it("新建：追加到末尾并切过去", async () => {
    const first = api.active;
    await act(async () => api.add());
    expect(api.entries).toHaveLength(2);
    expect(api.entries[0].key).toBe(first);
    expect(api.active).toBe(api.entries[1].key);
  });

  it("报告元信息：同引用不触发更新，换内容才落到条目上", async () => {
    const key = api.entries[0].key;
    const m = meta(7, "改 read_files 上限");
    await act(async () => api.report(key, m));
    expect(api.entries[0].meta).toBe(m);
    // 同一个对象再报一次：按引用判重，条目里的 meta 还是那一个（不新建数组）
    await act(async () => api.report(key, m));
    expect(api.entries[0].meta).toBe(m);
  });

  it("关闭当前会话：落到相邻一条，并让后端关掉它", async () => {
    await act(async () => api.add());
    await act(async () => api.add());
    const [a, b, c] = api.entries;
    await act(async () => api.report(b.key, meta(42, "第二条")));
    await act(async () => api.setActive(b.key));
    await act(async () => api.close(b.key));
    expect(api.entries.map((e) => e.key)).toEqual([a.key, c.key]);
    // b 在中间 ⇒ 落到原来位置上的那一条（c）
    expect(api.active).toBe(c.key);
    expect(h.invoke).toHaveBeenCalledWith("cc_close_session", { sessionId: 42 });
  });

  it("关掉最后一条右边的：落到左边那条（不会越界）", async () => {
    await act(async () => api.add());
    const [a, b] = api.entries;
    await act(async () => api.setActive(b.key));
    await act(async () => api.close(b.key));
    expect(api.active).toBe(a.key);
  });

  it("最后一条不许关（界面至少留一个对话区）", async () => {
    const only = api.entries[0];
    await act(async () => api.close(only.key));
    expect(api.entries).toHaveLength(1);
    expect(api.active).toBe(only.key);
  });

  it("还没铸发内部 id 的会话：只从列表移除，不发关闭命令", async () => {
    await act(async () => api.add());
    const [a, b] = api.entries;
    await act(async () => api.close(b.key));
    expect(api.entries.map((e) => e.key)).toEqual([a.key]);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("Ctrl+Tab 循环切换（正向到底回到第一条，反向同理）", async () => {
    await act(async () => api.add());
    await act(async () => api.add());
    const [a, b, c] = api.entries;
    await act(async () => api.setActive(c.key));
    await act(async () => api.cycle(1));
    expect(api.active).toBe(a.key);
    await act(async () => api.cycle(-1));
    expect(api.active).toBe(c.key);
    await act(async () => api.cycle(-1));
    expect(api.active).toBe(b.key);
  });

  it("只有一条时切换是空操作（不会把 active 变成 undefined）", async () => {
    const only = api.active;
    await act(async () => api.cycle(1));
    expect(api.active).toBe(only);
  });
});
