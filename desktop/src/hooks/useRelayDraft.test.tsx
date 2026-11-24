// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRelayDraft } from "./useRelayDraft";
import type { RelaySnapshot } from "../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let form: ReturnType<typeof useRelayDraft>;

function Probe({ snapshot }: { snapshot: RelaySnapshot | undefined }) {
  form = useRelayDraft(snapshot, () => {});
  return null;
}

/** 一份「已保存」的快照：上游地址 / 模型 / 分档 / maxTokens 都有值。 */
function savedSnapshot(over: Partial<RelaySnapshot> = {}): RelaySnapshot {
  const provider = {
    name: "saved",
    baseUrl: "https://saved.example.com/v1/messages",
    apiKeyMasked: "sk-…",
    hasApiKey: true,
    kind: "anthropic",
    authStyle: "x-api-key" as const,
    maxTokensLimit: 8192,
    foldToolBlocks: true,
    configured: true,
    missing: null,
  };
  return {
    running: true,
    addr: "127.0.0.1:4100",
    uptimeSecs: 60,
    listenHost: "127.0.0.1",
    port: 4100,
    tokenMasked: "rly_…",
    token: "rly_x",
    stats: {
      todayRequests: 0,
      todayFolded: 0,
      todayErrors: 0,
      todayErrorRate: 0,
      firstByteP50Ms: null,
      firstByteP95Ms: null,
      avgTotalMs: null,
      tierHits: [],
      lastError: null,
      lastErrorAtMs: null,
      inFlight: 0,
    },
    recent: [],
    provider,
    tiers: [
      { tier: "default", alias: "claude-sonnet-5-5", envVar: "ANTHROPIC_MODEL", upstreamModel: "up-model", configured: true },
      { tier: "haiku", alias: "claude-haiku-5-5", envVar: "ANTHROPIC_DEFAULT_HAIKU_MODEL", upstreamModel: "", configured: false },
      { tier: "opus", alias: "claude-opus-5-5", envVar: "ANTHROPIC_DEFAULT_OPUS_MODEL", upstreamModel: "", configured: false },
    ],
    ...over,
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.toast.mockReset();
  mocks.invoke.mockResolvedValue({
    ok: true,
    configured: true,
    missing: null,
    restartRequired: false,
    warnings: [],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("中转表单草稿的回填", () => {
  // 复现事故：中转页签无 keepMounted 会卸载，而 useRelayStatus 的 gcTime 是 30s——
  // 30 秒内切回时 React Query **首渲染就返回缓存快照**，`snapshot` 第一次就是
  // defined，不存在「先 undefined 再到达」的间隙。修复前 `lastServer` 指纹机制
  // 依赖那个间隙，回填分支永不执行 ⇒ 表单停在空白、dirty 恒真 ⇒ 失焦即存
  // 把已保存的上游地址/模型/分档/authStyle/maxTokens 全部清空。
  it("从缓存快照重挂载时回填已保存值，且不是 dirty", async () => {
    await act(async () => {
      root.render(<Probe snapshot={savedSnapshot()} />);
    });
    expect(form.draft.baseUrl).toBe("https://saved.example.com/v1/messages");
    expect(form.draft.model).toBe("up-model");
    expect(form.draft.maxTokens).toBe("8192");
    expect(form.draft.authStyle).toBe("x-api-key");
    expect(form.draft.fold).toBe(true);
    expect(form.dirty).toBe(false);
  });

  it("保存提交的是表单当前值，不会把未回填的空值写回后端", async () => {
    await act(async () => {
      root.render(<Probe snapshot={savedSnapshot()} />);
    });
    await act(async () => {
      await form.save();
    });
    const call = mocks.invoke.mock.calls.find((c) => c[0] === "relay_save");
    expect(call, "应发起 relay_save").toBeDefined();
    const patch = (call![1] as { patch: Record<string, unknown> }).patch;
    expect(patch.baseUrl).toBe("https://saved.example.com/v1/messages");
    expect(patch.model).toBe("up-model");
    expect(patch.maxTokensLimit).toBe(8192);
    // 没换密钥就不该带上 apiKey（空串在后端的约定是「不改」）。
    expect(patch.apiKey).toBeUndefined();
  });

  it("用户没改过的字段跟随轮询更新，改过的不被冲掉", async () => {
    const snapshot = savedSnapshot();
    await act(async () => {
      root.render(<Probe snapshot={snapshot} />);
    });
    // 轮询带来新上游地址：用户没改过 ⇒ 跟随。
    const moved = savedSnapshot({
      provider: { ...snapshot.provider!, baseUrl: "https://moved.example.com/v1/messages" },
    });
    await act(async () => {
      root.render(<Probe snapshot={moved} />);
    });
    expect(form.draft.baseUrl).toBe("https://moved.example.com/v1/messages");

    // 用户正在改：不被轮询冲掉。
    await act(async () => {
      form.setField({ baseUrl: "https://typing.example.com" });
    });
    await act(async () => {
      root.render(<Probe snapshot={moved} />);
    });
    expect(form.draft.baseUrl).toBe("https://typing.example.com");
    expect(form.dirty).toBe(true);
  });

  it("首帧无快照（新挂载）时空态不脏，快照到达后回填", async () => {
    await act(async () => {
      root.render(<Probe snapshot={undefined} />);
    });
    expect(form.dirty).toBe(false);
    await act(async () => {
      root.render(<Probe snapshot={savedSnapshot()} />);
    });
    expect(form.draft.baseUrl).toBe("https://saved.example.com/v1/messages");
    expect(form.dirty).toBe(false);
  });

  it("apiKey 是一次性的：保存成功后从草稿里消失，但不参与回填比对", async () => {
    await act(async () => {
      root.render(<Probe snapshot={savedSnapshot()} />);
    });
    await act(async () => {
      form.setField({ apiKey: "sk-new" });
    });
    expect(form.dirty).toBe(true);
    await act(async () => {
      await form.save();
    });
    // 密钥输完就该从内存里消失（下一段输入不会被上一段污染）。
    expect(form.draft.apiKey).toBe("");
    expect(form.dirty).toBe(false);
  });
});
