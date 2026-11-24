// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelaySnapshot } from "../../lib/types";

// 快照由用例切换。桩掉数据订阅而不是真发 IPC：这里要验的是「三种状态各自渲染成
// 什么」，不是轮询本身（那部分在 Rust 侧与 useRelayStatus 里）。
// `invoke` 单独拎出来是为了能查「保存到底发了什么」——见最后一个用例。
const mocks = vi.hoisted(() => ({
  snapshot: { current: undefined as RelaySnapshot | undefined },
  invoke: vi.fn(),
}));
vi.mock("../../hooks/useRelayStatus", () => ({
  useRelayStatus: () => ({
    data: mocks.snapshot.current,
    series: { requests: [], firstByte: [], fold: [], errors: [] },
    isError: false,
    refetch: () => {},
  }),
}));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
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
  // 保存一律成功返回：本文件要验的是「发了什么」，不是失败分支。
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async () => ({ configured: true, missing: null, warnings: [] }));
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

  // ── 密钥「取消」回归 ────────────────────────────────────────────────
  //
  // Escape 只收输入框、不清草稿的话，那枚被取消的密钥会留在 draft 里，
  // 之后任意一次 commit（改别的字段失焦、切鉴权方式）都把它静默写进配置——
  // 用户以为没保存，实际上保存了。断言点选在 IPC patch 上：取消之后
  // 的保存，patch 里**不允许出现 apiKey 这一项**。

  /** React 受控 input：原生 setter + input 事件，直接赋 value 不触发 onChange。 */
  async function typeInto(sel: string, value: string) {
    const el = host.querySelector<HTMLInputElement>(sel);
    expect(el, `应有 ${sel}`).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el!, value);
      el!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("取消更换密钥：被取消的密钥不得随之后的保存写进配置", async () => {
    await mount(snapshot());

    const replaceBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "更换");
    expect(replaceBtn, "已配密钥时应出现「更换」按钮").toBeTruthy();
    await act(async () => {
      replaceBtn!.click();
    });

    const keyInput = host.querySelector<HTMLInputElement>("#relay-api-key");
    expect(keyInput, "点「更换」后应展开密钥输入框").not.toBeNull();
    await typeInto("#relay-api-key", "sk-canceled-by-escape");
    await act(async () => {
      keyInput!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(host.querySelector("#relay-api-key"), "Escape 后输入框应收回").toBeNull();

    // 之后改另一个字段并失焦，触发一次正常保存
    await typeInto("#relay-base-url", "https://other.example.com");
    await act(async () => {
      host
        .querySelector("#relay-base-url")!
        .dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    const saveCall = mocks.invoke.mock.calls.find((c) => c[0] === "relay_save");
    expect(saveCall, "改字段失焦应触发保存").toBeTruthy();
    const { patch } = saveCall![1] as { patch: Record<string, unknown> };
    expect(patch.baseUrl, "新地址正常保存").toBe("https://other.example.com");
    expect(patch, "被 Escape 取消的密钥不许进 patch").not.toHaveProperty("apiKey");
  });

  it("max_tokens 超 u32：输入侧限长、失焦说人话且不保存，改对后仍能存", async () => {
    await mount(snapshot());
    const sel = '[aria-label="max_tokens 上限"]';

    // 超过 10 位直接截断：u32 上限就 10 位数，更长连后端都进不去
    await typeInto(sel, "99999999999");
    expect(host.querySelector<HTMLInputElement>(sel)!.value, "输入应被限到 10 位").toBe("9999999999");

    // 10 位仍可能超 u32（9999999999 > 4294967295）：后端 Option<u32> 会整条
    // 拒绝、报错还是 serde 天书——必须在前端拦住、说人话、且**不保存**
    await act(async () => {
      host.querySelector(sel)!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(host.textContent).toContain("max_tokens 不能超过 4294967295");
    expect(
      mocks.invoke.mock.calls.some((c) => c[0] === "relay_save"),
      "超限时不许触发保存",
    ).toBe(false);

    // 自愈路径：改成合法值后失焦，正常保存（拦住不能把表单卡死）
    await typeInto(sel, "4096");
    await act(async () => {
      host.querySelector(sel)!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    const saveCall = mocks.invoke.mock.calls.find((c) => c[0] === "relay_save");
    expect(saveCall, "改对之后应能保存").toBeTruthy();
    const { patch } = saveCall![1] as { patch: { maxTokensLimit: number } };
    expect(patch.maxTokensLimit).toBe(4096);
  });
});
