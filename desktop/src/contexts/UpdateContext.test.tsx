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
 * 3. 安装完成后等待确认，重启前复查真实任务状态。
 * 4. `total=null`（源不给 Content-Length）走不确定态，且后续带 total 时能恢复百分比。
 *
 * 只 mock 掉三个展示组件：本文件测的是状态机，不是渲染。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider, friendlyError, useUpdate, type UpdateState } from "./UpdateContext";

// ─── 事件总线与 IPC 打桩 ────────────────────
// vi.hoisted：mock 工厂会被提升到 import 之前，所以共享状态必须一起提升。
const h = vi.hoisted(() => {
  const handlers = new Map<string, ((e: { payload: unknown }) => void)[]>();
  /** 记录 listen/invoke 的调用顺序，用来断言「先注册监听、再发起检查」 */
  const order: string[] = [];
  /** 弹框每次渲染的 open 值；最后一项即当前是否可见 */
  const dialogOpen: boolean[] = [];
  /** 默认 IPC 实现：会随用例被覆盖，beforeEach 里恢复它，避免 mockImplementation 泄漏。 */
  const defaultInvoke = async (cmd: string) => {
    order.push(`invoke:${cmd}`);
    if (cmd === "update_activity") {
      return { conversations: 0, agents: 0, commands: 0, transfers: 0 };
    }
    // 默认不强制：绝大多数用例不该因为多了一次策略检查而进入强制态。
    if (cmd === "check_update_policy") {
      return { mandatory: false, currentVersion: "3.4.0", source: "network-miss" };
    }
    return undefined;
  };
  return {
    handlers,
    order,
    dialogOpen,
    defaultInvoke,
    /** 最近一次渲染拿到的 onClose，测试里用来模拟用户点「稍后提醒」 */
    closeDialog: undefined as (() => void) | undefined,
    invoke: vi.fn<(cmd: string) => Promise<unknown>>(defaultInvoke),
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
vi.mock("../components/update/UpdateNotesDialog", () => ({
  UpdateNotesDialog: (props: { open: boolean; onClose: () => void }) => {
    h.dialogOpen.push(props.open);
    h.closeDialog = props.onClose;
    return null;
  },
}));
vi.mock("../components/update/RestartOverlay", () => ({ RestartOverlay: () => null }));

const EVENTS = [  "update:checking",
  "update:available",
  "update:downloading",
  "update:progress",
  "update:verifying",
  "update:staged",
  "update:obsolete",
  "update:ready",
  "update:error",
  "update:uptodate",
];

const LAST_CHECK_KEY = "ccbridge_last_update_check";
const DISMISSED_KEY = "ccbridge_dismissed_update_version";
const PRELOAD_KEY = "ccbridge_auto_preload_update";

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

/** 弹框当前是否打开（取 mock 最后一次渲染的 open）。 */
function dialogOpen(): boolean {
  return h.dialogOpen[h.dialogOpen.length - 1] ?? false;
}

/** 模拟用户点弹框里的「稍后提醒」/关闭按钮。 */
async function closeDialog() {
  await act(async () => {
    h.closeDialog?.();
  });
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

const available = (version = "99.9.9") => ({
  version,
  body: "### 更新摘要\n- 测试",
  date: "2026-10-18T00:00:00Z",
  currentVersion: "2.9.1",
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(PRELOAD_KEY, "false");
  h.handlers.clear();
  h.order.length = 0;
  h.dialogOpen.length = 0;
  h.closeDialog = undefined;
  h.invoke.mockClear();
  // 上一个用例可能换过实现（强制策略），必须恢复默认，否则会泄漏到后面的用例。
  h.invoke.mockImplementation(h.defaultInvoke);
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

  it("update:ready 置 100% 并保持已安装状态", async () => {
    await mount();
    await emit("update:available", available());
    await act(async () => {
      void state().downloadAndInstall();
    });
    await emit("update:ready");

    expect(state().status).toBe("ready");
    expect(state().progress).toBe(100);

    // 已安装状态只能重启，重复下载不能覆盖它。
    h.invoke.mockClear();
    await act(async () => {
      void state().downloadAndInstall();
    });
    expect(h.invoke).not.toHaveBeenCalledWith("start_update");
  });

  it("后台检查完成不能覆盖正在下载或已安装的状态", async () => {
    await mount();
    await emit("update:available", available());
    await act(async () => state().downloadAndInstall());
    await emit("update:uptodate");
    await emit("update:error", { source: "check", message: "后台检查超时" });
    expect(state().status).toBe("downloading");
    expect(state().update?.version).toBe(available().version);

    await emit("update:ready");
    await emit("update:uptodate");
    expect(state().status).toBe("ready");
  });

  it("下载换源时显示实际下载的版本，且不重新打开普通弹框", async () => {
    await mount();
    await emit("update:available", available());
    await act(async () => state().downloadAndInstall());
    await closeDialog();
    await emit("update:available", { ...available("100.0.0"), source: "download" });
    expect(state().update?.version).toBe("100.0.0");
    expect(state().status).toBe("downloading");
    expect(dialogOpen()).toBe(false);
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

/**
 * 「有更新就弹框」（2026-11-26 恢复）。
 *
 * 之前刻意只亮角标 + toast，不打断用户；现在按需求恢复成发现新版本直接弹框。
 * 但必须守住两条去重规则，否则每次 24 小时定时检查都会再弹一次、变成骚扰：
 * 1. 同一次运行里同一版本只自动弹一次；关窗 = 「稍后提醒」，下次启动会再提醒；
 * 2. 点过「忽略此版本」后，这个版本即使手动检查也不再弹（跨会话持久化）。
 */
describe("发现新版本自动弹框", () => {
  it("自动检查命中新版本时自动打开更新框", async () => {
    await mount();
    expect(dialogOpen()).toBe(false);

    await emit("update:available", available("99.9.9"));

    expect(dialogOpen()).toBe(true);
  });

  it("同一次运行里同一版本只弹一次，关掉后不再重复弹", async () => {
    await mount();
    await emit("update:available", available("99.9.9"));
    expect(dialogOpen()).toBe(true);

    // 用户点「稍后提醒」/关闭：只关窗，不写「忽略」记忆。
    await closeDialog();
    expect(dialogOpen()).toBe(false);

    // 24 小时定时检查再次命中同一版本：不应再弹。
    await emit("update:available", available("99.9.9"));
    expect(dialogOpen()).toBe(false);
  });

  it("换一个新版本仍会自动弹", async () => {
    await mount();
    await emit("update:available", available("99.9.9"));
    await closeDialog();

    await emit("update:available", available("100.0.0"));
    expect(dialogOpen()).toBe(true);
  });

  it("「忽略此版本」后，同版本即使手动检查也不再弹", async () => {
    await mount();
    await emit("update:available", available("99.9.9"));
    await closeDialog();
    await act(async () => {
      state().dismissUpdate();
    });

    await act(async () => {
      await state().manualCheckForUpdate();
    });
    await emit("update:available", available("99.9.9"));

    expect(dialogOpen()).toBe(false);
    expect(state().isDismissed("99.9.9")).toBe(true);
  });

  it("手动检查发现新版本时弹框（无视本会话已提醒过的去重）", async () => {
    await mount();
    await emit("update:available", available("99.9.9"));
    await closeDialog();

    await act(async () => {
      await state().manualCheckForUpdate();
    });
    await emit("update:available", available("99.9.9"));

    expect(dialogOpen()).toBe(true);
  });

  it("一次手动检查不会污染后续自动检查（不重复弹）", async () => {
    await mount();
    // 手动检查命中：用户主动问，弹。
    await act(async () => {
      await state().manualCheckForUpdate();
    });
    await emit("update:available", available("99.9.9"));
    expect(dialogOpen()).toBe(true);
    await closeDialog();

    // 同一次运行里定时自动检查再命中：manual 标记已被消费 + 本会话已弹过 ⇒ 不弹。
    await act(async () => {
      await state().checkForUpdate();
    });
    await emit("update:available", available("99.9.9"));
    expect(dialogOpen()).toBe(false);
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

describe("后台预下载", () => {
  const forced = {
    mandatory: true, currentVersion: "3.4.0", minSupportedVersion: "3.5.0", latestVersion: "3.5.0", source: "network",
  };

  it("发现更新后自动准备，签名验证完成才提示，点击安装只用本地包", async () => {
    localStorage.removeItem(PRELOAD_KEY);
    await mount();
    await emit("update:available", available("3.5.0"));
    expect(state().status).toBe("downloading");
    expect(dialogOpen()).toBe(false);
    expect(h.invoke).toHaveBeenCalledWith("start_update");
    await emit("update:verifying");
    expect(state().status).toBe("verifying");
    expect(dialogOpen()).toBe(false);
    await emit("update:staged", { ...available("3.5.0"), size: 12000 });
    expect(state().status).toBe("staged");
    expect(dialogOpen()).toBe(true);
    expect(h.invoke).not.toHaveBeenCalledWith("install_prepared_update", { version: "3.5.0" });
    await act(async () => state().installPreparedUpdate());
    expect(h.invoke).toHaveBeenCalledWith("install_prepared_update", { version: "3.5.0" });
    expect(h.invoke.mock.calls.filter(([cmd]) => cmd === "start_update")).toHaveLength(1);
  });

  it("强制策略接管合格的下载并在撤销后解除强制界面", async () => {
    localStorage.removeItem(PRELOAD_KEY);
    await mount();
    await emit("update:available", available("3.5.0"));
    await emit("update:progress", { downloaded: 500, total: 1000 });
    h.invoke.mockImplementation(async cmd => cmd === "check_update_policy" ? forced : h.defaultInvoke(cmd));
    await act(async () => state().refreshForcePolicy());
    expect(state().forceUpdate.active).toBe(true);
    expect(state().progress).toBe(50);
    expect(h.invoke.mock.calls.filter(([cmd]) => cmd === "start_update")).toHaveLength(1);
    await emit("update:staged", { ...available("3.5.0"), size: 1000 });
    expect(dialogOpen()).toBe(false);
    expect(state().status).toBe("staged");
    h.invoke.mockImplementation(h.defaultInvoke);
    await act(async () => state().refreshForcePolicy());
    expect(state().forceUpdate.active).toBe(false);
    expect(dialogOpen()).toBe(true);
  });

  it("策略判定还未完成时暂缓普通提醒和安装", async () => {
    let finishPolicy: ((value: unknown) => void) | undefined;
    h.invoke.mockImplementation(async cmd => cmd === "check_update_policy"
      ? new Promise(resolve => { finishPolicy = resolve; })
      : h.defaultInvoke(cmd));
    await mount();
    await emit("update:staged", { ...available("3.5.0"), size: 1024 });
    await act(async () => state().installPreparedUpdate());
    expect(dialogOpen()).toBe(false);
    expect(h.invoke.mock.calls.some(([cmd]) => cmd === "install_prepared_update")).toBe(false);
    await act(async () => finishPolicy?.({ mandatory: false }));
    expect(dialogOpen()).toBe(true);
  });

  it("下载目标低于强制门槛时才重新准备", async () => {
    localStorage.removeItem(PRELOAD_KEY);
    await mount();
    await emit("update:available", available("3.4.1"));
    h.invoke.mockImplementation(async cmd => cmd === "check_update_policy" ? forced : h.defaultInvoke(cmd));
    await act(async () => state().refreshForcePolicy());
    expect(h.invoke.mock.calls.filter(([cmd]) => cmd === "start_update")).toHaveLength(1);
    await emit("update:obsolete");
    expect(h.invoke).toHaveBeenCalledWith("start_update", { minSupportedVersion: "3.5.0" });
    expect(h.invoke.mock.calls.filter(([cmd]) => cmd === "start_update")).toHaveLength(2);
  });

  it("关闭预下载仍可复用已校验的缓存，任务忙时保留安装包", async () => {
    await mount();
    await emit("update:staged", { ...available("3.5.0"), size: 1024 });
    expect(state().status).toBe("staged");
    h.invoke.mockImplementation(async cmd => cmd === "install_prepared_update" ? "busy" : h.defaultInvoke(cmd));
    await act(async () => state().installPreparedUpdate());
    expect(state().status).toBe("staged");
    expect(h.invoke).not.toHaveBeenCalledWith("start_update");
  });
});

describe("确认重启与任务保护", () => {
  it("ready 不自动重启，也不允许重新下载覆盖已安装状态", async () => {
    await mount(); await emit("update:available", available()); await emit("update:ready");
    expect(state().autoRestartIn).toBeNull();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(h.relaunch).not.toHaveBeenCalled();
    await act(async () => { void state().downloadAndInstall(); void state().manualCheckForUpdate(); });
    expect(h.invoke).not.toHaveBeenCalledWith("start_update");
    expect(state().status).toBe("ready");
  });
  it("忙碌或状态查询失败时禁止重启", async () => {
    await mount(); await emit("update:ready");
    h.invoke.mockResolvedValueOnce({ conversations: 1, agents: 2, commands: 0, transfers: 0 });
    await act(async () => state().restart());
    expect(h.relaunch).not.toHaveBeenCalled();
    h.invoke.mockRejectedValueOnce(new Error("activity unavailable"));
    await act(async () => state().restart());
    expect(h.relaunch).not.toHaveBeenCalled();
    expect(state().restarting).toBe(false);
  });
  it("安全检查期间立即反馈，检查结果阻止重启时撤掉过渡层", async () => {
    await mount(); await emit("update:ready");
    let finish!: (activity: unknown) => void;
    h.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await act(async () => { void state().restart(); });
    expect(state().restarting).toBe(true);
    expect(h.relaunch).not.toHaveBeenCalled();
    await act(async () => { finish({ conversations: 0, agents: 1, commands: 0, transfers: 0 }); });
    expect(h.relaunch).not.toHaveBeenCalled(); expect(state().restarting).toBe(false);
  });

  it("安全检查通过就重启，无需推进动画计时器", async () => {
    await mount(); await emit("update:ready");
    await act(async () => { void state().restart(); });
    expect(h.relaunch).toHaveBeenCalledOnce();
  });

  it("relaunch 抛错时 restarting 必须复位，且状态留在 ready", async () => {
    h.relaunch.mockRejectedValueOnce(new Error("relaunch boom"));
    await mount();
    await emit("update:available", available());
    await emit("update:ready");

    await act(async () => state().restart());

    expect(h.relaunch).toHaveBeenCalledTimes(1);
    // 🔴 不复位就是「过渡层永久盖住界面、用户只能杀进程」。
    expect(state().restarting).toBe(false);
    // 刻意不落成 error：更新已安装完成，最准确的语义仍是「再点一次重启」。
    expect(state().status).toBe("ready");
    expect(state().error).toContain("relaunch boom");
  });

  it("手动重启连按两次只 relaunch 一次", async () => {
    await mount();
    await emit("update:ready");
    await act(async () => {
      void state().restart();
      void state().restart();
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

/**
 * 强制更新策略（2026-11-26）。
 *
 * 判定本身在 Rust 侧（有 12 条单测钉版本比较/缓冲期/fail-open），这里只锁三件
 * 前端必须做对的事：
 * 1. `mandatory` 为 true 时进入强制态；
 * 2. 强制态下**不再叠一层**普通更新弹框（否则两个遮罩互相盖）；
 * 3. IPC 异常时放行 —— 启动路径不能因为一次未知错误把用户挡在门外。
 */
describe("强制更新策略", () => {
  const withPolicy = (policy: unknown) => {
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_update_policy") return policy;
      return h.defaultInvoke(cmd);
    });
  };

  const mandatory = {
    mandatory: true,
    currentVersion: "3.4.0",
    minSupportedVersion: "3.5.0",
    latestVersion: "3.5.0",
    message: "必须升级后继续使用",
    source: "network",
  };

  it("后端判定 mandatory 时进入强制态", async () => {
    withPolicy(mandatory);
    await mount();

    expect(state().forceUpdate.active).toBe(true);
    expect(state().forceUpdate.verdict?.minSupportedVersion).toBe("3.5.0");
  });

  it("非强制判定不锁界面（默认发版路径）", async () => {
    await mount();
    expect(state().forceUpdate.active).toBe(false);
  });

  it("强制态下普通更新弹框不再叠一层", async () => {
    withPolicy(mandatory);
    await mount();
    await emit("update:available", available("99.9.9"));

    // 状态照常进 available（强制遮罩内部要用版本信息），但不打开普通弹框。
    expect(state().status).toBe("available");
    expect(dialogOpen()).toBe(false);
  });

  it("策略判定晚于普通弹框时，强制态接管并关掉它", async () => {
    // 两个检查是并行发起的：普通检查可能先回来并弹框，策略 8 秒后才判定强制。
    // 这一拍如果不收掉普通弹框，就会有两个 Modal 叠着 —— 视觉上是同一块区域，
    // 但焦点陷阱是两层，Tab 会从上层串到下层。
    let releasePolicy: ((v: unknown) => void) | null = null;
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_update_policy") {
        return new Promise((resolve) => {
          releasePolicy = resolve;
        });
      }
      return h.defaultInvoke(cmd);
    });
    await mount();

    await emit("update:available", available("99.9.9"));
    expect(dialogOpen()).toBe(true);

    await act(async () => {
      releasePolicy?.(mandatory);
    });

    expect(state().forceUpdate.active).toBe(true);
    expect(dialogOpen()).toBe(false);
  });

  it("策略命令异常时按放行处理", async () => {
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_update_policy") throw new Error("ipc boom");
      return h.defaultInvoke(cmd);
    });
    await mount();

    expect(state().forceUpdate.active).toBe(false);
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

/**
 * 错误文案（2026-10-22）。
 *
 * 这三组断言锁的是同一件事：**别再把「源上没有 manifest」说成「你的网络有问题」**。
 * 插件对非 2xx 只打日志、最后统一抛 `ReleaseNotFound`，其中文/英文文案固定为
 * `Could not fetch a valid release JSON from the remote`；旧实现看到 "fetch" 就判网络，
 * 于是 Gitee 404 被翻译成「网络连接失败」，而真正的 `error sending request` 落到兜底。
 * 现在由后端 code 定性，字符串启发式只在旧后端/未知类型时兜底。
 */
describe("friendlyError", () => {
  const RELEASE_NOT_FOUND = "Could not fetch a valid release JSON from the remote";

  it("按 code 出文案：manifest 不甩锅给用户网络", () => {
    const fe = friendlyError(`全部更新源均检查失败: ${RELEASE_NOT_FOUND}`, "manifest");
    expect(fe.friendly).toContain("更新");
    expect(fe.friendly).not.toContain("网络");
    // 原始错误必须原样保留，UI 的 title 靠它给用户复制。
    expect(fe.raw).toContain("Could not fetch");
  });

  it("按 code 出文案：network / timeout / signature 各自可辨", () => {
    expect(friendlyError("x", "network").friendly).toContain("网络");
    expect(friendlyError("x", "timeout").friendly).toContain("超时");
    expect(friendlyError("x", "signature").friendly).toContain("校验失败");
    // 验签失败绝不能提示成「网络」——用户会一直重试，永远装不上。
    expect(friendlyError("x", "signature").friendly).not.toContain("网络");
  });

  it("无 code 时回退：插件那句 manifest 错误不能被当成网络故障", () => {
    const fe = friendlyError(`全部更新源均检查失败: ${RELEASE_NOT_FOUND}`);
    expect(fe.friendly).not.toContain("网络连接失败");
    expect(fe.friendly).toContain("更新");
  });

  it("无 code 时回退：真正的请求失败仍识别为网络问题", () => {
    const fe = friendlyError("下载安装失败: error sending request for url (https://x)");
    expect(fe.friendly).toContain("网络");
  });

  it("未知 code 不炸，落到兜底文案", () => {
    const fe = friendlyError("某个没见过的错误", "unknown");
    expect(fe.friendly).toBe("更新失败，请重试");
    expect(fe.raw).toBe("某个没见过的错误");
  });
});

/**
 * 「失败该不该打扰用户」（2026-10-22）。
 *
 * 自动检查（启动自检 / 24h 定时）失败曾经会弹红色 toast：用户什么都没点，开机就收到
 * 「更新服务器连不上」的警报。在公司网络封了 Gitee/GitHub 的环境里，这是每天一次的噪音。
 * 现在只有用户主动发起的动作（手动检查 / 点下载）才弹，状态本身仍然进 error，
 * 徽章与关于页照常显示「重试」，信息不丢。
 */
describe("失败提示的打扰程度", () => {
  it("启动自检失败：状态进 error，但不弹 toast", async () => {
    await mount(); // mount 内部会发起启动自检（自动）
    await emit("update:error", {
      message: "全部更新源均检查失败（已依次尝试）: x",
      code: "manifest",
    });

    expect(state().status).toBe("error");
    expect(state().errorCode).toBe("manifest");
    expect(state().errorToastAllowed).toBe(false);
  });

  it("用户手动检查失败：要弹", async () => {
    await mount();
    await act(async () => {
      await state().manualCheckForUpdate();
    });
    await emit("update:error", { message: "x", code: "network" });

    expect(state().status).toBe("error");
    expect(state().errorCode).toBe("network");
    expect(state().errorToastAllowed).toBe(true);
  });

  it("下载安装失败：要弹（下载是明确的手动动作）", async () => {
    await mount();
    await emit("update:available", available("9.9.9"));
    await act(async () => {
      await state().downloadAndInstall();
    });
    await emit("update:error", { message: "x", code: "signature" });

    expect(state().errorCode).toBe("signature");
    expect(state().errorToastAllowed).toBe(true);
  });
});
