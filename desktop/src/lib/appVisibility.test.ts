import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 捕获 listen 注册的回调，用来模拟 Rust 侧发来的 `app:visibility` 事件。
let hostHandler: ((e: { payload: boolean }) => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (e: { payload: boolean }) => void) => {
    hostHandler = cb;
    return Promise.resolve(() => {
      hostHandler = undefined;
    });
  },
}));

import {
  initAppVisibility,
  isAppHidden,
  subscribeAppVisibility,
  __resetAppVisibilityForTest,
} from "./appVisibility";

/**
 * 最小 document stub。为何不用 jsdom：本仓库 vitest 跑在 node 环境且未装 jsdom/happy-dom，
 * 而被测逻辑只用到 `document.hidden` / visibilitychange / 一个属性读写，
 * 为此引入一整套 DOM 实现不划算。
 */
function installDocumentStub() {
  const attrs = new Set<string>();
  const domListeners = new Set<() => void>();
  const doc = {
    hidden: false,
    documentElement: {
      setAttribute: (k: string) => attrs.add(k),
      removeAttribute: (k: string) => attrs.delete(k),
    },
    addEventListener: (type: string, cb: () => void) => {
      if (type === "visibilitychange") domListeners.add(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      if (type === "visibilitychange") domListeners.delete(cb);
    },
  };
  vi.stubGlobal("document", doc);
  // 把 OS 级隐藏（如最小化）模拟成 document.hidden 变化 + visibilitychange。
  const setDocHidden = (v: boolean) => {
    doc.hidden = v;
    domListeners.forEach((cb) => cb());
  };
  return { attrs, setDocHidden };
}

describe("appVisibility store", () => {
  let env: ReturnType<typeof installDocumentStub>;

  beforeEach(() => {
    env = installDocumentStub();
    initAppVisibility();
  });

  afterEach(() => {
    __resetAppVisibilityForTest();
    vi.unstubAllGlobals();
    hostHandler = undefined;
  });

  it("初始可见：不置 data-app-hidden", () => {
    expect(isAppHidden()).toBe(false);
    expect(env.attrs.has("data-app-hidden")).toBe(false);
  });

  it("Rust 侧发 visible=false 时置位并通知订阅者", async () => {
    const seen: boolean[] = [];
    subscribeAppVisibility(() => seen.push(isAppHidden()));
    // listen 是异步注册的，等它落定。
    await Promise.resolve();

    hostHandler?.({ payload: false });
    expect(isAppHidden()).toBe(true);
    expect(env.attrs.has("data-app-hidden")).toBe(true);
    expect(seen).toEqual([true]);

    hostHandler?.({ payload: true });
    expect(isAppHidden()).toBe(false);
    expect(env.attrs.has("data-app-hidden")).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("重复同值不重复通知（去重，Resized 会密集到达）", async () => {
    let calls = 0;
    subscribeAppVisibility(() => calls++);
    await Promise.resolve();

    hostHandler?.({ payload: false });
    hostHandler?.({ payload: false });
    hostHandler?.({ payload: false });
    expect(calls).toBe(1);
  });

  it("两路信号取“或”：document.hidden 为真时，即使宿主说可见也算隐藏", async () => {
    await Promise.resolve();

    env.setDocHidden(true);
    expect(isAppHidden()).toBe(true);

    // 宿主发“可见”，但 OS 层仍隐藏 → 仍应为隐藏，不能被单边信号掰醒。
    hostHandler?.({ payload: true });
    expect(isAppHidden()).toBe(true);

    // 两边都可见才算可见。
    env.setDocHidden(false);
    expect(isAppHidden()).toBe(false);
  });

  it("dispose 后复位，避免热更新后轮询永久停死", async () => {
    await Promise.resolve();
    hostHandler?.({ payload: false });
    expect(isAppHidden()).toBe(true);

    __resetAppVisibilityForTest();
    expect(isAppHidden()).toBe(false);
    expect(env.attrs.has("data-app-hidden")).toBe(false);
  });

  it("initAppVisibility 幂等：重复调用不重复订阅", async () => {
    await Promise.resolve();
    const first = hostHandler;
    initAppVisibility();
    await Promise.resolve();
    // 第二次调用直接返回，不会再走 listen（否则 hostHandler 会被新回调覆盖）。
    expect(hostHandler).toBe(first);
  });
});
