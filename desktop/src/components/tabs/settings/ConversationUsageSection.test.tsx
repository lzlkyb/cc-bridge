// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationUsageSection } from "./ConversationUsageSection";
import { ViewActivityContext } from "../../../lib/viewActivity";
import type { CcSessionUsageRow, TokenUsageSession } from "../../../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement, qc: QueryClient;
beforeEach(() => {
  mocks.invoke.mockReset();
  // retry:false：失败用例不该让 react-query 退避重试，把测试拖慢。
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  qc.clear();
  host.remove();
});

async function mount(rows: CcSessionUsageRow[], toolSessions: TokenUsageSession[] = []) {
  mocks.invoke.mockResolvedValue(rows);
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <ConversationUsageSection toolSessions={toolSessions} />
      </QueryClientProvider>
    );
  });
  // 再排一拍：render 那一刻 invoke 的 promise 还没 resolve。且 react-query 的
  // 订阅通知走 notifyManager 的默认调度 `systemSetTimeoutZero`——**宏任务**，
  // 只 await 微任务（`act(async () => {})`）冲不出 loading，必须让出一个 setTimeout。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function row(sessionId: string, over: Partial<CcSessionUsageRow> = {}): CcSessionUsageRow {
  return {
    sessionId,
    connectionId: "",
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.01,
    turns: 2,
    updatedAt: 1_700_000_000,
    ...over,
  };
}

describe("ConversationUsageSection（对话账）", () => {
  it("按 sessionId join 工具账：有归属显示估算值，没有显示占位符", async () => {
    await mount(
      [
        row("s-1", { title: "修终端 bug", inputTokens: 40000, outputTokens: 2000, costUsd: 0.23, turns: 5 }),
        row("s-2", { inputTokens: 1000, outputTokens: 500 }),
      ],
      [{ sessionId: "s-1", calls: 12, estInput: 30000, estOutput: 4000 }]
    );
    expect(mocks.invoke).toHaveBeenCalledWith("cc_session_usage");
    const rows = host.querySelectorAll(".usage-conv-row");
    expect(rows).toHaveLength(2);
    // 第一行：标题 + 轮次 + token(42000) + 成本 + 工具估算(34000)
    expect(rows[0].textContent).toContain("修终端 bug");
    expect(rows[0].textContent).toContain("5 轮");
    expect(rows[0].textContent).toContain("4.2万");
    expect(rows[0].textContent).toContain("$0.23");
    expect(rows[0].textContent).toContain("~3.4万");
    // 第二行没有工具归属 → 占位符，且不显示成 0（0 会被读成「调了但没耗」）
    expect(rows[1].querySelector(".usage-conv-tool")?.textContent).toBe("—");
  });

  it("标题缺省时退回 session id 前 8 位", async () => {
    await mount([row("abcdef1234567890")]);
    const name = host.querySelector(".usage-conv-name")!;
    expect(name.textContent).toBe("abcdef12…");
    expect(name.getAttribute("title")).toBe("abcdef12…");
  });

  it("空数据显示引导文案，并始终给出「两套账不能相加」的提示", async () => {
    await mount([]);
    expect(host.textContent).toContain("还没有记录到对话用量");
    expect(host.textContent).toContain("两套账不能相加");
    expect(host.querySelector(".usage-conv")).toBeNull();
  });

  it("合计行汇总展示中的行，表头给出五列列名", async () => {
    await mount([
      row("s-1", { inputTokens: 40000, outputTokens: 2000, costUsd: 0.23 }),
      row("s-2", { inputTokens: 1000, outputTokens: 500, costUsd: 0.01 }),
    ]);
    expect(host.textContent).toContain("最近 2 条会话合计");
    // 0.23 + 0.01 = 0.24（锁 reduce 逻辑；token 和的万位舍入由 fmtTokens 单测覆盖）
    expect(host.textContent).toContain("$0.24");
    expect(host.querySelector(".usage-conv-head")?.textContent).toBe("会话轮次token成本工具(估)");
  });

  it("最多展示 6 条会话（SHOW_SESSIONS），避免压过卡里其他分区", async () => {
    await mount(Array.from({ length: 9 }, (_, i) => row(`s-${i}`)));
    expect(host.querySelectorAll(".usage-conv-row")).toHaveLength(6);
    expect(host.textContent).toContain("最近 6 条会话合计");
  });

  it("视图不活跃时不发请求（与工具账同一套门控）", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <ViewActivityContext.Provider value={false}>
            <ConversationUsageSection toolSessions={[]} />
          </ViewActivityContext.Provider>
        </QueryClientProvider>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
