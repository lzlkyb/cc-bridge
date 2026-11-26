// @vitest-environment jsdom
/**
 * 强制更新遮罩的行为测试。
 *
 * 这里只锁「用户能不能绕过去」这一类断言：
 * - 强制态必须盖住界面、且**没有**关闭入口（无关闭按钮、Esc 无效、无「稍后提醒」）；
 * - 非强制态完全不渲染（默认发版路径不能多出一个遮罩）。
 *
 * 判定逻辑（版本比较 / 缓冲期 / fail-open）在 Rust 侧单测里，前端不重复实现。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { ForceUpdateGate } from "./ForceUpdateGate";

const h = vi.hoisted(() => {
  const handlers = new Map<string, ((e: { payload: unknown }) => void)[]>();
  // 显式放宽返回类型：用例会按需替换 check_update_policy 的返回值（强制/非强制）。
  const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
    if (cmd === "check_update_policy") {
      return {
        mandatory: true,
        currentVersion: "3.4.0",
        minSupportedVersion: "3.5.0",
        latestVersion: "3.5.0",
        message: "3.4.2 之前的版本存在凭据泄露风险",
        source: "network",
      };
    }
    if (cmd === "update_activity") {
      return { conversations: 0, agents: 0, commands: 0, transfers: 0 };
    }
    return undefined;
  });
  return { handlers, invoke, exit: vi.fn(async () => {}) };
});

vi.mock("../../lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}), exit: h.exit }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    const list = h.handlers.get(event) ?? [];
    list.push(handler);
    h.handlers.set(event, list);
    return () => {
      const cur = h.handlers.get(event) ?? [];
      h.handlers.set(event, cur.filter((fn) => fn !== handler));
    };
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function flush(times = 12) {
  for (let i = 0; i < times; i++) await act(async () => {});
}

const MANDATORY = {
  mandatory: true,
  currentVersion: "3.4.0",
  minSupportedVersion: "3.5.0",
  latestVersion: "3.5.0",
  message: "3.4.2 之前的版本存在凭据泄露风险",
  source: "network",
};

async function mount(policy: Record<string, unknown> = MANDATORY) {
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "check_update_policy") return policy;
    if (cmd === "update_activity") return { conversations: 0, agents: 0, commands: 0, transfers: 0 };
    return undefined;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <UpdateProvider>
        <ForceUpdateGate />
      </UpdateProvider>,
    );
  });
  await flush();
}

const bodyText = () => document.body.textContent ?? "";

beforeEach(() => {
  localStorage.clear();
  h.handlers.clear();
  h.invoke.mockClear();
  h.exit.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("强制更新遮罩", () => {
  it("收到更新清单后仍显示最低支持版本和强制更新原因", async () => {
    await mount();
    await act(async () => {
      for (const fn of h.handlers.get("update:available") ?? []) {
        fn({ payload: { version: "3.5.0", body: null, currentVersion: "3.4.0" } });
      }
    });
    await flush();
    expect(bodyText()).toContain("最低支持版本 v3.5.0");
    expect(bodyText()).toContain("3.4.2 之前的版本存在凭据泄露风险");
  });
  it("强制态盖住界面并展示版本门槛与原因", async () => {
    await mount(); // 默认策略 mandatory=true
    const text = bodyText();

    expect(text).toContain("需要更新后才能继续使用");
    expect(text).toContain("3.4.2 之前的版本存在凭据泄露风险");
    expect(text).toContain("退出软件");
    expect(text).toContain("立即更新");
  });

  it("没有任何关闭入口：无关闭按钮、无稍后/忽略", async () => {
    await mount();
    const text = bodyText();

    expect(document.querySelector('[aria-label="关闭更新弹窗"]')).toBeNull();
    expect(text).not.toContain("稍后提醒");
    expect(text).not.toContain("忽略此版本");
  });

  it("Esc 不能关掉遮罩", async () => {
    await mount();
    const surface = document.querySelector('[role="dialog"]');
    expect(surface).not.toBeNull();

    await act(async () => {
      surface?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // 仍在界面上：强制态下 Esc 必须无效，否则「必须更新」形同虚设。
    expect(bodyText()).toContain("需要更新后才能继续使用");
  });

  it("首屏用版本事实填掉空白（这一步还没有更新正文）", async () => {
    await mount();
    const text = bodyText();

    expect(text).toContain("最低支持版本");
    expect(text).toContain("v3.5.0");
    expect(text).toContain("更新方式");
  });

  it("初始焦点在主按钮，不落在可滚动区", async () => {
    await mount();
    // 落在滚动区会命中 :focus-visible，沿它画一整圈描边（空内容时像多余边框）。
    const active = document.activeElement as HTMLElement | null;
    expect(active?.tagName).toBe("BUTTON");
    expect(active?.textContent).toBe("立即更新");
  });

  it("非强制判定完全不渲染", async () => {
    await mount({ mandatory: false, currentVersion: "3.4.0", source: "network-miss" });

    expect(bodyText()).not.toContain("需要更新后才能继续使用");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("「退出软件」调用 process.exit（策略误伤时的逃生口）", async () => {
    await mount();
    const quit = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "退出软件");
    expect(quit).toBeTruthy();

    await act(async () => {
      quit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(h.exit).toHaveBeenCalled();
  });

  it("下载中不再说「关闭弹框后仍会继续下载」", async () => {
    // 强制态这一屏关不掉，沿用提醒态的文案会自相矛盾。
    await mount();
    const start = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "立即更新");
    expect(start).toBeTruthy();

    await act(async () => {
      start?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(h.invoke).toHaveBeenCalledWith("start_update", { minSupportedVersion: "3.5.0" });
    const text = bodyText();
    expect(text).toContain("下载完成后会自动启动安装，请先保存当前工作。");
    expect(text).not.toContain("关闭弹框后仍会继续下载");
  });
});
