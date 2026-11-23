// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelaySnapshot } from "../../lib/types";

// 快照由用例切换。桩掉数据订阅而不是真发 IPC：这里要验的是「三种状态各自渲染成
// 什么」，不是轮询本身（那部分在 Rust 侧与 useRelayStatus 里）。
const mocks = vi.hoisted(() => ({ snapshot: { current: undefined as RelaySnapshot | undefined } }));
vi.mock("../../hooks/useRelayStatus", () => ({
  useRelayStatus: () => ({
    data: mocks.snapshot.current,
    series: { requests: [], firstByte: [], fold: [], errors: [] },
    isError: false,
    refetch: () => {},
  }),
}));
vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(async () => ({})) }));
// 复制粘贴走的是 Tauri 剪贴板插件，jsdom 里没有；本用例不点复制按钮，只需能加载。
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  copyText: vi.fn(async () => true),
}));

const { RelayTab } = await import("./RelayTab");
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(patch: Partial<RelaySnapshot> = {}): RelaySnapshot {
  return {
    running: true,
    addr: "127.0.0.1:4100",
    uptimeSecs: 3_600,
    listenHost: "127.0.0.1",
    port: 4100,
    tokenMasked: "rly_7f3a…4b8d",
    token: "rly_7f3a9c2e4b8d",
    provider: {
      name: "qianwenaiapi",
      baseUrl: "https://up.example.com",
      apiKeyMasked: "sk-…3f9a",
      hasApiKey: true,
      kind: "anthropic",
      authStyle: "x-api-key",
      maxTokensLimit: null,
      foldToolBlocks: true,
      configured: true,
      missing: null,
    },
    tiers: [
      { tier: "default", alias: "claude-sonnet-5-5", envVar: "ANTHROPIC_MODEL", upstreamModel: "qwen4-max-preview", configured: true },
      { tier: "haiku", alias: "claude-haiku-5-5", envVar: "ANTHROPIC_DEFAULT_HAIKU_MODEL", upstreamModel: "", configured: false },
      { tier: "opus", alias: "claude-opus-5-5", envVar: "ANTHROPIC_DEFAULT_OPUS_MODEL", upstreamModel: "", configured: false },
    ],
    stats: {
      todayRequests: 1_284,
      todayFolded: 37,
      todayErrors: 1,
      todayErrorRate: 0.08,
      firstByteP50Ms: 412,
      firstByteP95Ms: 1_200,
      avgTotalMs: 900,
      tierHits: [
        { tier: "default", count: 1_233, fellBack: 0 },
        { tier: "haiku", count: 38, fellBack: 38 },
        { tier: "opus", count: 13, fellBack: 13 },
      ],
      lastError: "上游返回 429（claude-sonnet-5-5）",
      lastErrorAtMs: Date.now() - 600_000,
      inFlight: 0,
    },
    recent: [
      {
        id: 1,
        tsMs: Date.now(),
        source: "local",
        clientModel: "claude-sonnet-5-5",
        tier: "default",
        upstreamModel: "qwen4-max-preview",
        fellBack: false,
        via: "alias",
        rewrite: "fold",
        foldSummary: "messages[1].content[1] 合并 tool_definition",
        sanitized: true,
        status: 200,
        firstByteMs: 412,
        totalMs: 980,
        bytesIn: 1_024,
        bytesOut: 2_048,
        error: null,
        path: "/v1/messages",
      },
    ],
    ...patch,
  };
}

let root: Root;
let host: HTMLDivElement;

async function mount(value?: RelaySnapshot) {
  mocks.snapshot.current = value;
  await act(async () => root.render(<RelayTab />));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("中转页三种状态", () => {
  it("运行中：链路、四张指标、日志、档位与接入代码块都在", async () => {
    await mount(snapshot());
    const text = host.textContent ?? "";
    expect(text).toContain("当前中转");
    expect(text).toContain("qianwenaiapi");
    expect(text).toContain("qwen4-max-preview");
    // 四张指标卡
    for (const label of ["今日请求", "首字 P50", "改写率", "错误率"]) expect(text).toContain(label);
    // 映射名只有一个，且是档位别名而不是上游真名
    expect(host.querySelector(".relay-alias-name")?.textContent).toBe("claude-sonnet-5-5");
    // 日志与档位卡
    expect(text).toContain("请求日志");
    expect(text).toContain("档位分布");
    // 接入代码块用的是真实值：地址、令牌、别名
    const code = host.querySelector(".relay-code")?.textContent ?? "";
    expect(code).toContain('"ANTHROPIC_BASE_URL": "http://127.0.0.1:4100"');
    expect(code).toContain("rly_7f3a9c2e4b8d");
    expect(code).toContain('"ANTHROPIC_MODEL": "claude-sonnet-5-5"');
    // 上游真名不得出现在远端那份文件里
    expect(code).not.toContain("qwen4-max-preview");
  });

  it("关闭态：状态卡换「未在监听」，指标一律破折号，接入块换成怎么开回来", async () => {
    await mount(snapshot({ running: false, addr: null, uptimeSecs: null }));
    const text = host.textContent ?? "";
    expect(text).toContain("未在监听");
    expect(host.querySelector(".status-card--stopped")).not.toBeNull();
    // 关闭期间不计数：显示 0 会被读成「在跑但没流量」
    expect(host.querySelector(".metric-card .metric-value")?.textContent).toContain("—");
    expect(text).toContain("怎么开回来");
    // 没有流量就别摆日志与档位卡
    expect(text).not.toContain("请求日志");
    // 配置卡仍然可编辑，并标了「待生效」
    expect(host.querySelector("#relay-base-url")).not.toBeNull();
    expect(text).toContain("待生效");
  });

  it("还没配上游：headline 与徽章都换成中性态，不再谎报「已连通」", async () => {
    await mount(
      snapshot({
        provider: { ...snapshot().provider!, configured: false, missing: "model", baseUrl: "", hasApiKey: false },
        stats: { ...snapshot().stats, todayRequests: 0, todayFolded: 0, todayErrors: 0, todayErrorRate: 0, firstByteP50Ms: null, firstByteP95Ms: null },
      }),
    );
    const text = host.textContent ?? "";
    expect(text).toContain("未配置上游");
    expect(text).toContain("未设置");
    expect(host.querySelector(".relay-badge")?.getAttribute("data-tone")).toBe("idle");
  });
});
