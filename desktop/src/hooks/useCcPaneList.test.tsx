// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  cliSessionId: null,
  rowId: null,
  title,
  turns: 1,
  state: "idle",
  restoring: false,
  detail: "1 轮 · 空闲",
  connectionId: "",
  targetLabel: "本机",
  cwd: "",
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.invoke.mockResolvedValue(true);
  // `close` 成功后要 `invalidateQueries`，所以必须有 QueryClient。
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>));
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

describe("载入意图（3-1c）", () => {
  /**
   * 🔴 回归 3-1b 的隐性缺陷：每个新 pane 都在挂载时调 `cc_restore` 取最近那条，
   * 于是 `+` 出来的第二条会**重复载入上一条的内容**。只有进页面的第一条该恢复。
   */
  it("首条 = latest，+ 出来的 = none", async () => {
    expect(api.entries[0].restore).toEqual({ kind: "latest" });
    await act(async () => api.add());
    expect(api.entries[1].restore).toEqual({ kind: "none" });
  });

  it("打开历史：新开一条带 rowId 的条目并切过去，不动原来那条", async () => {
    const first = api.active;
    await act(async () => api.openStored(31));
    expect(api.entries).toHaveLength(2);
    expect(api.entries[0].key).toBe(first);
    expect(api.entries[1].restore).toEqual({ kind: "row", rowId: 31 });
    expect(api.active).toBe(api.entries[1].key);
  });

  it("关掉一条已落盘的会话会让历史列表失效重取（它该重新出现在历史区）", async () => {
    await act(async () => api.add());
    const b = api.entries[1];
    await act(async () => api.report(b.key, meta(9, "有内容的")));
    await act(async () => api.close(b.key));
    expect(h.invoke).toHaveBeenCalledWith("cc_close_session", { sessionId: 9 });
  });

  /** 连点两下同一行不该得到两个一模一样的 pane。 */
  it("同一行重复打开只开一条", async () => {
    await act(async () => api.openStored(31));
    await act(async () => api.openStored(31));
    expect(api.entries.filter((e) => e.restore.kind === "row")).toHaveLength(1);
    // 换一行仍然照开
    await act(async () => api.openStored(32));
    expect(api.entries.filter((e) => e.restore.kind === "row")).toHaveLength(2);
  });
});

describe("分叉（3-3）", () => {
  const seed = {
    sourceSessionId: "s-1",
    sourceTitle: "源会话",
    connectionId: "",
    cwd: "D:/proj",
    model: "sonnet",
    permissionMode: "default" as const,
    digest: "【用户】旧话",
    omitted: 0,
    text: "改过的说法",
  };

  it("新开一条带 seed 的条目并切过去，原条目不动", async () => {
    const origin = api.active;
    await act(async () => api.forkFrom(origin, seed));
    expect(api.entries).toHaveLength(2);
    const forked = api.entries[1];
    expect(forked.restore).toEqual({ kind: "seed", seed });
    // 侧栏靠它把两条摆在一起
    expect(forked.forkOf).toBe(origin);
    expect(api.active).toBe(forked.key);
  });

  it("同一处可以连着分叉多次（与「打开历史」不同，这里不去重）", async () => {
    const origin = api.active;
    await act(async () => api.forkFrom(origin, seed));
    await act(async () => api.forkFrom(origin, seed));
    expect(api.entries.filter((e) => e.restore.kind === "seed")).toHaveLength(2);
    // 两次都要指向同一个来源，侧栏才会把它们摆成一组
    expect(api.entries.filter((e) => e.forkOf === origin)).toHaveLength(2);
  });
});
