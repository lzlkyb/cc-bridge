// @vitest-environment jsdom
/**
 * UpdateContext 状态机单测（2026-10-18）。
 *
 * 为什么值得单独测：整条更新链路的可观测行为全在这 7 个 `update:*` 事件上，而这些事件
 * 由 Rust 后台线程注入，人工测一次要点十几下、还得等下载。这里把它们改成「手动 emit」，
 * 于是状态转移、倒计时、复位这些最容易回归的路径全都变成毫秒级断言。
 *
 * 覆盖的重点（按价值排序）：
 * 1. **启动自检必须在监听器注册完成之后**——否则 `update:available` 会在注册前发出、
 *    永久丢失（这是 CI 在真实 macOS runner 上抓到过的竞态，见 UpdateContext 里的长注释）。
 * 2. **`relaunch` 抛错时 `restarting` 必须复位**——唯一会导致「过渡层永久盖住界面、
 *    用户只能杀进程」的失败路径。
 * 3. **8 秒自动重启倒计时**：到点触发、取消后不再触发、下一轮恢复。
 * 4. `total=null`（源不给 Content-Length）走不确定态，且后续带 total 时能恢复百分比。
 *
 * 只 mock 掉三个展示组件：本文件测的是状态机，不是渲染。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_RESTART_DELAY_SECS, UpdateProvider, useUpdate, type UpdateState } from "./UpdateContext";

// ─── 事件总线与 IPC 打桩 ────────────────────
// vi.hoisted：mock 工厂会被提升到 import 之前，所以共享状态必须一起提升。
const h = vi.hoisted(() => {
  const handlers = new Map<string, ((e: { payload: unknown }) => void)[]>();
  /** 记录 listen/invoke 的调用顺序，用来断言「先注册监听、再发起检查」 */
  const order: string[] = [];
  return {
    handlers,
    order,
    invoke: vi.fn(async (cmd: string) => {
      order.push(`invoke:${cmd}`);
      return undefined;
    }),
    relaunch: vi.fn(async () => {}),
  };
});

vi.mock("../lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: h.relaunch }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    h.order.push(`listen:${event}`);
    const list = h.handlers.get(event) ?? [];
    list.push(handler);
    h.handlers.set(event, list);
    return () => {
      const cur = h.handlers.get(event) ?? [];
      h.handlers.set(
        event,
        cur.filter((fn) => fn !== handler),
      );
    };
  },
}));
vi.mock("../components/update/UpdateNotesDialog", () => ({ UpdateNotesDialog: () => null }));
vi.mock("../components/update/RestartOverlay", () => ({ RestartOverlay: () => null }));

const EVENTS = [  "update:checking",
  "update:available",
  "update:downloading",
  "update:progress",
  "update:ready",
  "update:error",
  "update:uptodate",
];

const LAST_CHECK_KEY = "ccbridge_last_update_check";
const DISMISSED_KEY = "ccbridge_dismissed_update_version";

// React 18 的 act 需要这个标记，否则每次 act 都会打「environment is not configured」警告，
// 且异步副作用不会被正确 flush。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── 渲染工具 ────────────────────────────

/** 探针：把 context 值抓到一个外部变量里，断言时直接读它。 */
let ctx: UpdateState | null = null;
function Probe() {
  ctx = useUpdate();
  return null;
}

function state(): UpdateState {
  if (!ctx) throw new Error("Probe 尚未渲染");
  return ctx;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** flush 微任务链：setupListeners 串行 await 7 个 listen，每轮只推进一个。 */
async function flush(times = 12) {
  for (let i = 0; i < times; i++) await act(async () => {});
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
  });
  await flush();
}

/** 模拟 Rust 侧 emit：直接调用注册过的 handler。 */
async function emit(event: string, payload?: unknown) {
  const list = h.handlers.get(event) ?? [];
  await act(async () => {
    for (const fn of list) fn({ payload });
  });
}

/**
 * 走完「倒计时 → 过渡层 → relaunch」。
 *
 * 必须分两步推进：倒计时归零后才在 effect 里调 restart()，而 restart() 的
 * RESTART_OVERLAY_MS 定时器要等 effect 跑完才注册——一次 advance 到底的话，
 * 那个 1.1 秒 timer 根本没机会被推进（表现为 relaunch 一次都没被调用）。
 */
async function advanceToRelaunch() {
  await act(async () => {
    vi.advanceTimersByTime(AUTO_RESTART_DELAY_SECS * 1000);
  });
  await act(async () => {
    vi.advanceTimersByTime(1200);
  });
}

const available = (version = "99.9.9") => ({
  version,
  body: "### 更新摘要\n- 测试",
  date: "2026-10-18T00:00:00Z",
  currentVersion: "2.9.1",
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  h.handlers.clear();
  h.order.length = 0;
  h.invoke.mockClear();
  h.relaunch.mockClear();
  h.relaunch.mockImplementation(async () => {});
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  ctx = null;
  vi.useRealTimers();
});

// ─── 用例 ────────────────────────────────

describe("监听注册与启动自检的顺序", () => {
  it("7 个监听器全部注册后才发起启动自检", async () => {
    await mount();

    expect([...h.handlers.keys()].sort()).toEqual([...EVENTS].sort());

    const invokeAt = h.order.indexOf("invoke:check_update");
    const lastListenAt = h.order.reduce((last, cur, i) => (cur.startsWith("listen:") ? i : last), -1);
    expect(invokeAt).toBeGreaterThan(-1);
    // 关键断言：检查必须晚于**最后一个** listen，否则事件可能发在监听之前而丢失。
    expect(invokeAt).toBeGreaterThan(lastListenAt);
  });

  it("24 小时内不重复发起可见检查（走静默路径，不动 UI 状态）", async () => {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    await mount();

    expect(h.invoke).toHaveBeenCalledWith("check_update");
    expect(state().status).toBe("idle");
  });

  it("超过 24 小时后发起可见检查，状态进入检查中", async () => {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now() - 25 * 60 * 60 * 1000));
    await mount();

    expect(state().status).toBe("checking");
  });
});

describe("事件驱动的状态转移", () => {
  it("update:available 带全量字段进入可更新态", async () => {
    await mount();
    await emit("update:available", available());

    expect(state().status).toBe("available");
    expect(state().update).toEqual(available());
  });

  it("update:progress 用 total 算百分比，字节数与速率原样进 state", async () => {
    await mount();
    await emit("update:downloading");
    await emit("update:progress", { downloaded: 5 * 1024 * 1024, total: 20 * 1024 * 1024, bytesPerSec: 2 * 1024 * 1024 });

    expect(state().status).toBe("downloading");
    expect(state().progress).toBe(25);
    expect(state().progressIndeterminate).toBe(false);
    expect(state().downloadedBytes).toBe(5 * 1024 * 1024);
    expect(state().totalBytes).toBe(20 * 1024 * 1024);
    expect(state().bytesPerSec).toBe(2 * 1024 * 1024);
  });

  it("total 为 null 时走不确定态，之后收到 total 能恢复百分比", async () => {
    await mount();
    await emit("update:downloading");
    await emit("update:progress", { downloaded: 1024 * 1024, total: null });

    expect(state().progressIndeterminate).toBe(true);
    expect(state().totalBytes).toBeNull();
    expect(state().downloadedBytes).toBe(1024 * 1024);

    // 恢复：不能一次 null 就永久卡在不确定态（读数会一直扫动）。
    await emit("update:progress", { downloaded: 2 * 1024 * 1024, total: 4 * 1024 * 1024 });
    expect(state().progressIndeterminate).toBe(false);
    expect(state().progress).toBe(50);
  });

  it("下载进行中收到 update:checking / update:available 不回退状态", async () => {
    await mount();
    await emit("update:available", available());
    await act(async () => {
      void state().downloadAndInstall();
    });
    expect(state().status).toBe("downloading");

    await emit("update:checking");
    expect(state().status).toBe("downloading");
    await emit("update:available", available("100.0.0"));
    expect(state().status).toBe("downloading");
    expect(state().update?.version).toBe("99.9.9");
  });

  it("update:ready 置 100% 并清掉下载守卫（可以再发起下载）", async () => {
    await mount();
    await emit("update:available", available());
    await act(async () => {
      void state().downloadAndInstall();
    });
    await emit("update:ready");

    expect(state().status).toBe("ready");
    expect(state().progress).toBe(100);

    // 守卫若没复位，这次调用会被静默吞掉 —— 表现是「装完了点不动」。
    h.invoke.mockClear();
    await act(async () => {
      void state().downloadAndInstall();
    });
    expect(h.invoke).toHaveBeenCalledWith("start_update");
  });

  it("update:error 记录原始文案并复位下载守卫", async () => {
    await mount();
    await emit("update:available", available());
    await act(async () => {
      void state().downloadAndInstall();
    });
    await emit("update:error", { message: "全部更新源均失败" });

    expect(state().status).toBe("error");
    expect(state().error).toBe("全部更新源均失败");

    h.invoke.mockClear();
    await act(async () => {
      void state().downloadAndInstall();
    });
    expect(h.invoke).toHaveBeenCalledWith("start_update");
  });
});

describe("下载重入防护", () => {
  it("同一帧内连点两次只发起一次 start_update", async () => {
    await mount();
    await emit("update:available", available());

    await act(async () => {
      void state().downloadAndInstall();
      void state().downloadAndInstall();
    });

    expect(h.invoke.mock.calls.filter((c) => c[0] === "start_update")).toHaveLength(1);
  });

  it("没有 update 信息时不发起下载", async () => {
    await mount();
    await act(async () => {
      void state().downloadAndInstall();
    });
    expect(h.invoke).not.toHaveBeenCalledWith("start_update");
  });
});

describe("8 秒自动重启窗口", () => {
  it("进入 ready 开始倒计时，到点自动 relaunch（含 1.1 秒过渡层）", async () => {
    await mount();
    await emit("update:available", available());
    await emit("update:ready");

    expect(state().autoRestartIn).toBe(AUTO_RESTART_DELAY_SECS);

    // 倒计时本身走完还不重启：restart() 里还有 RESTART_OVERLAY_MS 的仪式感等待。
    await act(async () => {
      vi.advanceTimersByTime(AUTO_RESTART_DELAY_SECS * 1000);
    });
    expect(h.relaunch).not.toHaveBeenCalled();
    expect(state().restarting).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });

  it("取消后本轮不再自动重启，且倒计时读数清空", async () => {
    await mount();
    await emit("update:available", available());
    await emit("update:ready");

    await act(async () => {
      state().cancelAutoRestart();
    });
    expect(state().autoRestartIn).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(h.relaunch).not.toHaveBeenCalled();
  });

  it("取消只影响本轮：下一次 ready 重新开始倒计时", async () => {
    await mount();
    await emit("update:ready");
    await act(async () => {
      state().cancelAutoRestart();
    });
    expect(state().autoRestartIn).toBeNull();

    // 真实顺序：第二轮下载会先经过 downloading，status 变化才会让倒计时 effect 重跑。
    await emit("update:downloading");
    await emit("update:ready");
    expect(state().autoRestartIn).toBe(AUTO_RESTART_DELAY_SECS);

    await advanceToRelaunch();
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });

  it("relaunch 抛错时 restarting 必须复位，且状态留在 ready", async () => {
    h.relaunch.mockRejectedValueOnce(new Error("relaunch boom"));
    await mount();
    await emit("update:available", available());
    await emit("update:ready");

    await advanceToRelaunch();

    expect(h.relaunch).toHaveBeenCalledTimes(1);
    // 🔴 不复位就是「过渡层永久盖住界面、用户只能杀进程」。
    expect(state().restarting).toBe(false);
    // 刻意不落成 error：更新已安装完成，最准确的语义仍是「再点一次重启」。
    expect(state().status).toBe("ready");
    expect(state().error).toContain("relaunch boom");
  });

  it("手动重启连按两次只 relaunch 一次", async () => {
    await mount();
    await act(async () => {
      void state().restart();
      void state().restart();
    });
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("已是最新（uptodate）与手动/自动区分", () => {
  it("自动检查命中 uptodate 不弹框，4 秒后回 idle", async () => {
    await mount();
    await emit("update:uptodate");

    expect(state().status).toBe("uptodate");
    expect(state().manualCheck).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(state().status).toBe("idle");
  });

  it("手动检查命中 uptodate 才置 manualCheck，可由 acknowledgeUptodate 消费", async () => {
    await mount();
    await act(async () => {
      void state().manualCheckForUpdate();
    });
    await emit("update:uptodate");

    expect(state().manualCheck).toBe(true);

    await act(async () => {
      state().acknowledgeUptodate();
    });
    expect(state().manualCheck).toBe(false);
  });

  it("auto 与 manual 交替时 manualCheck 只跟随最近一次检查", async () => {
    await mount();
    await act(async () => {
      void state().manualCheckForUpdate();
    });
    await emit("update:uptodate");
    expect(state().manualCheck).toBe(true);

    await act(async () => {
      state().acknowledgeUptodate();
      void state().checkForUpdate();
    });
    await emit("update:uptodate");
    expect(state().manualCheck).toBe(false);
  });
});

describe("「稍后」按版本抑制", () => {
  it("dismiss 写入 localStorage，isDismissed 只对同版本为真", async () => {
    await mount();
    await emit("update:available", available("99.9.9"));

    await act(async () => {
      state().dismissUpdate();
    });

    expect(localStorage.getItem(DISMISSED_KEY)).toBe("99.9.9");
    expect(state().isDismissed("99.9.9")).toBe(true);
    expect(state().isDismissed("100.0.0")).toBe(false);
    expect(state().isDismissed(undefined)).toBe(false);
  });

  it("重启后仍记得被抑制的版本（从 localStorage 恢复）", async () => {
    localStorage.setItem(DISMISSED_KEY, "99.9.9");
    await mount();
    expect(state().isDismissed("99.9.9")).toBe(true);
  });
});
