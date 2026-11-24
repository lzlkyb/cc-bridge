// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelaySnapshot, TunnelStatus } from "../../lib/types";

// 快照由用例切换。桩掉数据订阅而不是真发 IPC：这里要验的是「三种状态各自渲染成
// 什么」，不是轮询本身（那部分在 Rust 侧与 useRelayStatus 里）。
// `invoke` 单独拎出来是为了能查「保存到底发了什么」——见最后一个用例。
const mocks = vi.hoisted(() => ({
  snapshot: { current: undefined as RelaySnapshot | undefined },
  tunnels: new Map<string, TunnelStatus>(),
  invoke: vi.fn(),
}));
vi.mock("../../hooks/useRelayStatus", () => ({
  useRelayStatus: () => ({
    status: { data: mocks.snapshot.current, isError: false, refetch: vi.fn(async () => {}) },
    history: { isError: false, refetch: vi.fn(async () => {}) },
    rows: mocks.snapshot.current?.recent ?? [],
    today: new Date().toLocaleDateString("sv-SE"),
  }),
}));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/sshTunnelStore", () => ({
  useTunnelStatus: (id: string) => mocks.tunnels.get(id),
}));
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
let client: QueryClient;

async function mount(value?: RelaySnapshot) {
  mocks.snapshot.current = value;
  await act(async () => root.render(<QueryClientProvider client={client}><RelayTab /></QueryClientProvider>));
}

beforeEach(() => {
  // 保存一律成功返回：本文件要验的是「发了什么」，不是失败分支。
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => command === "ssh_list_connections"
    ? { enabled: true, connections: [{ id: "company", name: "公司", host: "server.example", port: 22, username: "alice" }] }
    : command === "relay_last_deploy" ? null
    : { configured: true, missing: null, warnings: [] });
  mocks.tunnels.clear();
  localStorage.removeItem("relaySshConnectionId");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe("中转页三种状态", () => {
  async function click(text: string, within: ParentNode = document.body) {
    const button = [...within.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
    expect(button, `应有「${text}」按钮`).toBeTruthy();
    await act(async () => button!.click());
  }

  it("运行中：模型路由、请求明细与接入配置可查看", async () => {
    mocks.tunnels.set("relay:company", {
      connectionId: "relay:company", state: "up", needsSecret: false, message: null,
      rules: [{
        rule: { id: "model-relay", enabled: true, kind: "remote", listenHost: "127.0.0.1",
          listenPort: 45201, targetHost: "127.0.0.1", targetPort: 4100, note: "" },
        state: "listening", boundPort: 45201, message: null,
      }],
    });
    await mount(snapshot());
    const text = host.textContent ?? "";
    expect(text).toContain("模型路由");
    expect(text).toContain("qianwenaiapi");
    expect(text).toContain("qwen4-max-preview");
    for (const label of ["今日请求", "首字 P50", "今日 Token", "最近请求", "查看档位映射"]) expect(text).toContain(label);
    await click("接入指南", host);
    await vi.waitFor(() => expect(document.body.querySelector(".relay-code")).not.toBeNull());
    const code = document.body.querySelector(".relay-code")?.textContent ?? "";
    expect(code).toContain('"ANTHROPIC_BASE_URL": "http://127.0.0.1:45201"');
    expect(code).toContain("rly_7f3a9c2e4b8d");
    expect(code).toContain('"ANTHROPIC_MODEL": "claude-sonnet-5-5"');
    // 上游真名不得出现在远端那份文件里
    expect(code).not.toContain("qwen4-max-preview");
  });

  it("接入需先建立转发，重连期间不提供失效的地址", async () => {
    await mount(snapshot());
    await click("接入指南", host);
    await vi.waitFor(() => expect(document.querySelector("#relay-ssh-server")).not.toBeNull());
    expect(document.querySelector(".relay-code")).toBeNull();
    await click("建立 SSH 转发");
    expect(mocks.invoke).toHaveBeenCalledWith("relay_tunnel_start", {
      connectionId: "company", password: null, passphrase: null, reallocate: false,
    });
    mocks.tunnels.set("relay:company", {
      connectionId: "relay:company", state: "reconnecting", needsSecret: false, message: null,
      rules: [{
        rule: { id: "model-relay", enabled: true, kind: "remote", listenHost: "127.0.0.1",
          listenPort: 45201, targetHost: "127.0.0.1", targetPort: 4100, note: "" },
        state: "listening", boundPort: 45201, message: null,
      }],
    });
    await mount(snapshot());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("SSH 正在重连");
    expect(document.querySelector(".relay-code")).toBeNull();
    const copy = [...document.querySelectorAll("button")].find(button => button.textContent === "复制远端配置");
    expect(copy?.disabled).toBe(true);

    const reconnecting = mocks.tunnels.get("relay:company")!;
    reconnecting.rules[0].state = "failed";
    await mount(snapshot());
    await click("重新分配端口");
    expect(mocks.invoke).toHaveBeenLastCalledWith("relay_tunnel_start", {
      connectionId: "company", password: null, passphrase: null, reallocate: true,
    });
  });

  it("内网直连仍使用原本的监听地址和端口", async () => {
    await mount(snapshot({ listenHost: "192.0.2.15", addr: "192.0.2.15:4100" }));
    await click("接入指南", host);
    expect(document.querySelector(".relay-code")?.textContent).toContain('"ANTHROPIC_BASE_URL": "http://192.0.2.15:4100"');
    expect(document.querySelector("#relay-ssh-server")).toBeNull();
    // 直连不建隧道、不显示隧道选择器；但「一键部署到远端」仍需 SSH 连接列表，
    // 故直连模式现在会拉 ssh_list_connections，部署目标选择器随之出现。
    await vi.waitFor(() => expect(document.querySelector("#relay-deploy-server")).not.toBeNull());
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_list_connections");
    expect(mocks.invoke).not.toHaveBeenCalledWith("relay_tunnel_start", expect.anything());
  });

  it("一键部署：隧道就绪后部署到远端，回显路径/服务账号/新终端提示", async () => {
    mocks.tunnels.set("relay:company", {
      connectionId: "relay:company", state: "up", needsSecret: false, message: null,
      rules: [{
        rule: { id: "model-relay", enabled: true, kind: "remote", listenHost: "127.0.0.1",
          listenPort: 45201, targetHost: "127.0.0.1", targetPort: 4100, note: "" },
        state: "listening", boundPort: 45201, message: null,
      }],
    });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "ssh_list_connections") {
        return { enabled: true, connections: [{ id: "company", name: "公司", host: "server.example", port: 22, username: "alice" }] };
      }
      if (command === "relay_deploy_config") {
        return {
          baseUrl: "http://127.0.0.1:45201",
          file: "/home/alice/.claude-own/own-model.json",
          home: "/home/alice",
          serviceAccount: "claude-svc",
          alias: "alias claude-own='claude --settings ~/.claude-own/own-model.json'",
          configJson: "{}",
        };
      }
      return { configured: true, missing: null, warnings: [] };
    });
    await mount(snapshot());
    await click("接入指南", host);
    await vi.waitFor(() => expect(document.querySelector("#relay-deploy-server")).not.toBeNull());
    await click("部署到远端");
    expect(mocks.invoke).toHaveBeenCalledWith("relay_deploy_config", {
      connectionId: "company", serviceAccount: null, model: null,
    });
    await vi.waitFor(() => expect(document.querySelector(".relay-deploy-result")).not.toBeNull());
    const result = document.querySelector(".relay-deploy-result")?.textContent ?? "";
    expect(result).toContain("/home/alice/.claude-own/own-model.json");
    expect(result).toContain("claude-svc");
    expect(result).toContain("开一个新终端");
  });

  it("P0：接入方式独立成块且置于代码块上方，不再埋卡头", async () => {
    await mount(snapshot({ listenHost: "192.0.2.15", addr: "192.0.2.15:4100" }));
    await click("接入指南", host);
    await vi.waitFor(() => expect(document.querySelector(".relay-method h3")).not.toBeNull());
    const method = document.querySelector(".relay-method")!;
    expect(method.querySelector("h3")!.textContent).toBe("接入方式");
    expect(method.querySelector(".stable-method-toggle")).not.toBeNull();
    expect(document.querySelector(".relay-card-head .stable-method-toggle")).toBeNull();
    const code = document.querySelector(".relay-code")!;
    expect(method.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("P1：直连 IP 漂移出橙色横幅＋重新部署/切隧道按钮，徽章回显当前地址", async () => {
    mocks.invoke.mockImplementation(async (command: string) => command === "ssh_list_connections"
      ? { enabled: true, connections: [{ id: "company", name: "公司", host: "server.example", port: 22, username: "alice" }] }
      : command === "relay_last_deploy" ? { url: "http://10.203.5.54:4100", connectionId: "company" }
      : { configured: true, missing: null, warnings: [] });
    await mount(snapshot({ listenHost: "10.203.5.45", addr: "10.203.5.45:4100" }));
    await vi.waitFor(() => expect(document.querySelector(".relay-work-notice")).not.toBeNull());
    const notice = document.querySelector(".relay-work-notice")!;
    expect(notice.textContent).toContain("本机地址已变");
    expect(notice.textContent).toContain("10.203.5.54");
    const labels = [...notice.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((t) => t.includes("一键重新部署"))).toBe(true);
    expect(labels.some((t) => t.includes("切隧道"))).toBe(true);
    expect(document.querySelector(".relay-addr-badge")!.textContent).toContain("10.203.5.45");
  });

  it("关闭态保留历史与上游设置，并提供启动操作", async () => {
    await mount(snapshot({ running: false, addr: null, uptimeSecs: null }));
    expect(host.textContent).toContain("已停止");
    expect(host.textContent).toContain("启动中转");
    expect(host.querySelector(".relay-work-table tbody")).not.toBeNull();
    expect(host.textContent).not.toContain("打开接入指南");
    await click("上游设置", host);
    expect(document.querySelector("#relay-base-url")).not.toBeNull();
  });

  it("历史请求不会把刚重启的监听标成已验证", async () => {
    await mount(snapshot({ clientVerified: false, latestClientStatus: null }));
    expect(host.querySelector(".relay-service-badge")?.textContent).toBe("等待首个成功请求");
    expect(host.querySelector(".relay-work-table tbody")).not.toBeNull();
    await click("接入指南", host);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("等待首个客户端成功请求");
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
    expect(text).toContain("配置上游供应商");
    expect(host.querySelector(".relay-service-badge")?.getAttribute("data-tone")).toBe("warn");
    expect(host.querySelector('input#relay-api-key[type="password"]')).not.toBeNull();
  });

  // ── 密钥「取消」回归 ────────────────────────────────────────────────
  //
  // Escape 只收输入框、不清草稿的话，那枚被取消的密钥会留在 draft 里，
  // 之后任意一次 commit（改别的字段失焦、切鉴权方式）都把它静默写进配置——
  // 用户以为没保存，实际上保存了。断言点选在 IPC patch 上：取消之后
  // 的保存，patch 里**不允许出现 apiKey 这一项**。

  /** React 受控 input：原生 setter + input 事件，直接赋 value 不触发 onChange。 */
  async function typeInto(sel: string, value: string) {
    const el = document.querySelector<HTMLInputElement>(sel);
    expect(el, `应有 ${sel}`).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el!, value);
      el!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("首次接入只在填齐三项并离开输入框后保存", async () => {
    await mount(snapshot({ provider: null, tiers: [], recent: [] }));
    const blur = async (selector: string) => act(async () => {
      document.querySelector(selector)!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await typeInto("#relay-base-url", "https://up.example.com");
    await blur("#relay-base-url");
    expect(mocks.invoke).not.toHaveBeenCalledWith("relay_save", expect.anything());
    await typeInto("#relay-api-key", "setup-key");
    await typeInto("#relay-model", "upstream-model");
    await blur("#relay-model");
    expect(mocks.invoke.mock.calls.filter((c) => c[0] === "relay_save")).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenCalledWith("relay_save", { patch: expect.objectContaining({
      baseUrl: "https://up.example.com", apiKey: "setup-key", model: "upstream-model",
    }) });
  });

  it("首次接入选择鉴权方式会一并保存已填齐的配置", async () => {
    await mount(snapshot({ provider: null, tiers: [], recent: [] }));
    await typeInto("#relay-base-url", "https://up.example.com");
    await typeInto("#relay-api-key", "setup-key");
    await typeInto("#relay-model", "upstream-model");
    const bearer = [...host.querySelectorAll("button")].find((button) => button.textContent === "Bearer")!;
    await act(async () => {
      host.querySelector("#relay-model")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: bearer }));
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("relay_save", expect.anything());
    await click("Bearer", host);
    expect(mocks.invoke.mock.calls.filter((c) => c[0] === "relay_save")).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenCalledWith("relay_save", { patch: expect.objectContaining({ authStyle: "bearer", apiKey: "setup-key" }) });
  });

  it("取消更换密钥：被取消的密钥不得随之后的保存写进配置", async () => {
    await mount(snapshot());
    await click("上游设置", host);

    const replaceBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "更换");
    expect(replaceBtn, "已配密钥时应出现「更换」按钮").toBeTruthy();
    await act(async () => {
      replaceBtn!.click();
    });

    const keyInput = document.querySelector<HTMLInputElement>("#relay-api-key");
    expect(keyInput, "点「更换」后应展开密钥输入框").not.toBeNull();
    await typeInto("#relay-api-key", "sk-canceled-by-escape");
    await act(async () => {
      keyInput!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(document.querySelector("#relay-api-key"), "Escape 后输入框应收回").toBeNull();

    // 之后改另一个字段并失焦，触发一次正常保存
    await typeInto("#relay-base-url", "https://other.example.com");
    await act(async () => {
      document
        .querySelector("#relay-base-url")!
        .dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(mocks.invoke.mock.calls.some((c) => c[0] === "relay_save")).toBe(false);
    await click("应用配置");

    const saveCall = mocks.invoke.mock.calls.find((c) => c[0] === "relay_save");
    expect(saveCall, "改字段失焦应触发保存").toBeTruthy();
    const { patch } = saveCall![1] as { patch: Record<string, unknown> };
    expect(patch.baseUrl, "新地址正常保存").toBe("https://other.example.com");
    expect(patch, "被 Escape 取消的密钥不许进 patch").not.toHaveProperty("apiKey");
  });

  it("max_tokens 超 u32：输入侧限长，应用时拦截，改对后仍能保存", async () => {
    await mount(snapshot());
    await click("上游设置", host);
    const sel = '[aria-label="max_tokens 上限"]';

    // 超过 10 位直接截断：u32 上限就 10 位数，更长连后端都进不去
    await typeInto(sel, "99999999999");
    expect(document.querySelector<HTMLInputElement>(sel)!.value, "输入应被限到 10 位").toBe("9999999999");

    // 10 位仍可能超 u32（9999999999 > 4294967295）：后端 Option<u32> 会整条
    // 拒绝、报错还是 serde 天书——必须在前端拦住、说人话、且**不保存**
    await act(async () => {
      document.querySelector(sel)!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("max_tokens 不能超过 4294967295");
    expect(
      mocks.invoke.mock.calls.some((c) => c[0] === "relay_save"),
      "超限时不许触发保存",
    ).toBe(false);

    // 自愈路径：改成合法值后失焦，正常保存（拦住不能把表单卡死）
    await typeInto(sel, "4096");
    await click("应用配置");
    const saveCall = mocks.invoke.mock.calls.find((c) => c[0] === "relay_save");
    expect(saveCall, "改对之后应能保存").toBeTruthy();
    const { patch } = saveCall![1] as { patch: { maxTokensLimit: number } };
    expect(patch.maxTokensLimit).toBe(4096);
  });

  it("Token 用量区分真实的零、部分采集与预估请求", async () => {
    const fixture = snapshot();
    const row = fixture.recent[0];
    const partial = { id: 2, usage: { input: 24, cacheRead: 0, cacheWrite: null, output: null, partial: true } };
    await mount({ ...fixture, recent: [{ ...row, ...partial }, row, { ...row, id: 3, path: "/v1/messages/count_tokens" }] });
    await click("Token 用量", host);
    expect(host.textContent).toContain("上报用量 1 / 2 条 · 1 条部分采集");
    const table = host.querySelector(".relay-work-table tbody")!;
    expect(table.children).toHaveLength(2);
    await act(async () => table.querySelector("button")!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("部分采集");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("缓存读取0");
  });
});
