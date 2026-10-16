import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "../lib/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { UpdateNotesDialog } from "../components/update/UpdateNotesDialog";
import { UpdateProgressBar } from "../components/update/UpdateProgressBar";
import { RestartOverlay } from "../components/update/RestartOverlay";

// ─── 类型定义 ────────────────────────────

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "uptodate";

/** 更新信息（由后端 check_update / start_update 通过事件推送，仅含展示所需字段，不再依赖插件 Update 对象） */
export interface UpdateInfo {
  version?: string;
  body?: string | null;
  /** 发布日期（ISO 8601 / RFC 3339），如 "2026-07-17T00:00:00Z" */
  date?: string | null;
  /** 当前运行版本，用于弹框里展示 "v旧 → v新" */
  currentVersion?: string;
}

export interface UpdateState {
  status: UpdateStatus;
  update: UpdateInfo | null;
  /** 下载进度 0-100 */
  progress: number;
  /** 进度未知（total=null，无法计算百分比）时为 true，UI 显示不确定态 */
  progressIndeterminate: boolean;
  /** 下载速率（字节/秒），~250ms 窗口重算一次；下载刚开始第一个窗口还没算完时为 0。 */
  bytesPerSec: number;
  /** 已下载字节数（后端每 chunk 都发 downloaded）；无总大小时用于展示"已下载 X MB" */
  downloadedBytes: number;
  /** 下载总量（字节）；后端拿不到 Content-Length 时为 null ⇒ UI 走不确定态 */
  totalBytes: number | null;
  /** 重启过渡层可见：点击重启后先播 1.1 秒仪式感过渡，再真正 relaunch */
  restarting: boolean;
  error: string | null;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restart: () => Promise<void>;
  /** 打开「查看更新内容」弹窗 */
  openUpdateNotes: () => void;
  /** 记住当前可用版本为「稍后」：本版本不再弹框（按版本号记忆，换版本自动解除） */
  dismissUpdate: () => void;
  /** 判断某版本是否已被「稍后」抑制 */
  isDismissed: (version?: string) => boolean;
  /** 本次「已是最新」提示是否来自手动检查：自动检查（启动/定时）不弹框，只在版本号 pill 提示 */
  manualCheck: boolean;
  /** 手动检查「已是最新」toast 已消费后复位 manualCheck */
  acknowledgeUptodate: () => void;
  /** 手动触发检查更新（用户主动点击，命中 uptodate 时才弹「已是最新」提示框） */
  manualCheckForUpdate: () => Promise<void>;
}

// ─── 友好错误翻译 ────────────────────────

export interface FriendlyError {
  /** 用户友好文案 */
  friendly: string;
  /** 原始错误信息（技术细节） */
  raw: string;
}

/** 将原始错误信息拆分为友好提示 + 原始错误 */
export function friendlyError(raw: string): FriendlyError {
  const lower = raw.toLowerCase();
  if (lower.includes("networkerror") || lower.includes("failed to fetch") || lower.includes("fetch")) {
    return { friendly: "网络连接失败，请检查网络后重试", raw };
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo") || lower.includes("dns")) {
    return { friendly: "无法解析更新服务器地址，请检查网络连接", raw };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { friendly: "连接超时，请稍后重试", raw };
  }
  if (lower.includes("403") || lower.includes("rate limit")) {
    return { friendly: "GitHub API 访问受限，请稍后重试", raw };
  }
  return { friendly: "更新失败，请重试", raw };
}

const UpdateContext = createContext<UpdateState | null>(null);

export function useUpdate() {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate 必须在 UpdateProvider 内使用");
  return ctx;
}

// ─── 常量 ──────────────────────────────

/** 自动检查间隔：24 小时 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "ccbridge_last_update_check";
/** 「稍后」抑制记忆：记录的版本号（本版本不再弹框，换版本自动解除） */
const DISMISSED_KEY = "ccbridge_dismissed_update_version";
/** 重启过渡层停留时长：这段刻意的等待本身就是「正在应用更新」的载体（方案 C） */
const RESTART_OVERLAY_MS = 1100;

// ─── Provider ────────────────────────────

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressIndeterminate, setProgressIndeterminate] = useState(false);
  const [bytesPerSec, setBytesPerSec] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  const checkingRef = useRef(false);
  const downloadingRef = useRef(false);
  /** 重启重入防护（与 downloadingRef 同理：state 在同帧内是旧值，挡不住连点） */
  const restartingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptodateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 标记当前这次检查是否为用户手动触发（区分自动/手动，决定是否弹「已是最新」框） */
  const manualCheckRef = useRef(false);
  const [manualCheck, setManualCheck] = useState(false);

  // ─── 静默检查（不改变 UI 状态，仅内部记录）─────
  // 统一走后端 check_update 命令，状态由事件驱动（update:available / update:uptodate）。

  const silentCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      await invoke("check_update");
    } catch {
      // 静默检查失败不处理
    } finally {
      checkingRef.current = false;
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    }
  }, []);

  // ─── 检查更新 ───────────────────────────
  // 统一走后端 check_update 命令；checking/available/uptodate/error 全部由后端事件驱动，
  // 前端不再各自维护一份检查逻辑（避免与 Rust 双真相源）。

  // ─── 检查更新（manual=false 自动/启动/定时；manual=true 用户主动点击）──
  // 自动检查只更新版本号区域状态、不弹「已是最新」提示框；手动检查命中 uptodate 才弹框。
  const runCheck = useCallback(async (manual: boolean) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    manualCheckRef.current = manual;
    setStatus("checking");
    setError(null);

    try {
      await invoke("check_update");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Update] 检查更新失败:", msg);
      setError(msg);
      setStatus("error");
    } finally {
      checkingRef.current = false;
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    }
  }, []);
  const checkForUpdate = useCallback(() => runCheck(false), [runCheck]);
  const manualCheckForUpdate = useCallback(() => runCheck(true), [runCheck]);

  // ─── 定时检查（启动自检见下方监听 effect）──────────

  useEffect(() => {
    // 定时检查不涉及竞态（首次触发在 CHECK_INTERVAL_MS 之后，监听器早已就绪），留在这里。
    // 启动自检已移到下方「监听后台更新事件」的 effect 里、await 完所有 listen 之后，
    // 原因见那里的注释。
    timerRef.current = setInterval(() => {
      checkForUpdate();
    }, CHECK_INTERVAL_MS);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (uptodateTimerRef.current) clearTimeout(uptodateTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 下载并安装（Rust 侧后台线程，不阻塞 UI）────

  // ─── 下载并安装（Rust 侧后台线程，不阻塞 UI）────
  // 重入防护：连点不会触发 start_update 并发双下载；调用即乐观置 downloading，
  // 由 update:ready / update:error 复位守卫。

  const downloadAndInstall = useCallback(async () => {
    if (!update || downloadingRef.current) return;
    downloadingRef.current = true;
    setStatus("downloading");
    setError(null);
    try {
      await invoke("start_update");
    } catch (e) {
      console.error("[Update] start_update invoke 失败:", e);
      setError(String(e));
      setStatus("error");
      downloadingRef.current = false;
    }
  }, [update]);

  // ─── 监听后台更新事件 ────────────────────

  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    // async 注册期间若组件已卸载（StrictMode/快速重挂载，cleanup 会早于 await 完成），
    // 立即注销刚注册的监听，避免监听器泄漏与重复注册。
    const track = (fn: UnlistenFn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };

    const setupListeners = async () => {
      track(
        await listen("update:checking", () => {
          // 下载进行中（start_update 内部复查也会发 checking），不回退状态
          if (downloadingRef.current) return;
          setStatus("checking");
          setError(null);
        }),
      );
      track(
        await listen<{ version: string; body: string | null; date?: string | null; currentVersion?: string }>("update:available", (e) => {
          // 下载进行中（start_update 内部复查会再发 available），保持 downloading 不被回退
          if (downloadingRef.current) return;
          setStatus("available");
          setUpdate({ version: e.payload.version, body: e.payload.body, date: e.payload.date, currentVersion: e.payload.currentVersion });
        }),
      );
      track(
        await listen("update:downloading", () => {
          setStatus("downloading");
          setProgress(0);
          setProgressIndeterminate(false);
          setBytesPerSec(0);
          setDownloadedBytes(0);
          setTotalBytes(null);
        }),
      );
      track(
        await listen<{ downloaded: number; total: number | null; bytesPerSec?: number }>("update:progress", (e) => {
          const { downloaded, total, bytesPerSec: bps } = e.payload;
          setDownloadedBytes(downloaded);
          // totalBytes 是状态条算「已下载/总量」与「剩余时间」的唯一来源；
          // total 为 null（源未返回 Content-Length）时保持 null ⇒ 状态条走不确定态。
          setTotalBytes(total);
          if (total) {
            setProgress(Math.round((downloaded / total) * 100));
            setProgressIndeterminate(false);
          } else {
            // total 未知（如某些源不返回 Content-Length）：无法计算百分比，标记不确定态
            setProgressIndeterminate(true);
          }
          setBytesPerSec(bps ?? 0);
        }),
      );
      track(
        await listen("update:ready", () => {
          setProgress(100);
          setStatus("ready");
          downloadingRef.current = false;
        }),
      );
      track(
        await listen<{ message: string }>("update:error", (e) => {
          console.error("[Update] 更新失败:", e.payload.message);
          setError(e.payload.message);
          setStatus("error");
          downloadingRef.current = false;
        }),
      );
      track(
        await listen("update:uptodate", () => {
          // 进入「已是最新」可见状态（版本号 pill 显示）；4 秒后自动回到 idle。
          // 仅手动检查才弹「已是最新」提示框（manualCheck），自动检查（启动/定时）不弹框。
          setStatus("uptodate");
          setUpdate(null);
          if (manualCheckRef.current) setManualCheck(true);
          manualCheckRef.current = false;
          if (uptodateTimerRef.current) clearTimeout(uptodateTimerRef.current);
          uptodateTimerRef.current = setTimeout(() => {
            setStatus((s) => (s === "uptodate" ? "idle" : s));
          }, 4000);
        }),
      );
    };

    // 启动自检必须等到**监听器全部注册完**才能发。
    //
    // 原来它在上方一个单独的 useEffect 里，而那个 effect 声明在本 effect 之前——
    // React 按声明顺序执行，于是「发起检查」早于「注册监听」。而 `listen()` 是异步的
    // （上面 7 个监听器每个都要一次 IPC 往返），而 Rust 侧 `check_update` 是 spawn 后
    // 很快就 emit。更新源响应够快时，`update:available` 会在监听注册完之前发出去、
    // **永久丢失** → 后端已经发现新版本，界面却显示「无更新」。
    //
    // 这是 CI 在真实 macOS 上抓到的：runner 到 GitHub 是同机房级延迟，启动后约 1 秒
    // 就拿到了新版本，稳定跑赢前端注册，于是重现了“有更新但不提示”。
    // 国内用户走 ghproxy/Gitee 通常慢，所以不易触发——但内网/快网下会命中。
    //
    // 仅交换两个 effect 的顺序不够：两边的 async 部分都在微任务队列里排队，
    // IPC 完成先后仍不保证。只有把它放在 `await` 完所有 listen 之后才真正无竞态。
    const doStartupCheck = async () => {
      const lastCheck = localStorage.getItem(LAST_CHECK_KEY);
      const now = Date.now();
      if (lastCheck && now - Number(lastCheck) < CHECK_INTERVAL_MS) {
        await silentCheck();
        return;
      }
      await checkForUpdate();
    };

    setupListeners().then(() => {
      // cancelled 时不再发起检查（组件已卸载，监听器也已注销）
      if (!cancelled) doStartupCheck();
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 重启应用（方案 C 2026-10-16：先播 1.1s 过渡层，再真正 relaunch）────

  const restart = useCallback(async () => {
    // 重入防护用 ref 而非 state：state 在同一次渲染里恒为旧值，双击 / 连按 Enter
    // 会在同一帧内拿到两次 `restarting === false` ⇒ 两次 relaunch（双杀进程）。
    // 本文件对下载用的是同一个套路（downloadingRef），保持一致。
    if (restartingRef.current) return;
    restartingRef.current = true;
    setRestarting(true);
    // 让过渡层播完再重启 —— 这段刻意的等待本身就是「仪式感」的载体。
    await new Promise((r) => setTimeout(r, RESTART_OVERLAY_MS));
    try {
      await relaunch();
    } catch (e) {
      // 🔴 必须复位。忘了这一步，过渡层会永久盖住界面、用户只能杀进程 ——
      // 那比现在「闪一下」更糟，也是本方案唯一需要专门验收的失败路径。
      console.error("[Update] 重启失败:", e);
      restartingRef.current = false;
      setRestarting(false);
      setError(String(e));
      // 🔴 刻意**不**把 status 打成 "error"：更新已经下载并安装完成，最准确的语义
      // 仍是「ready —— 再点一次重启」。打成 error 会让徽章变成「重试」，而那个
      // 分支触发的是 check_update，用户被迫重走「检查 → 下载」一整轮，纯属多余。
      // 失败反馈改由 UpdateBadge 监听 restarting 回落 + error 弹 toast。
    }
  }, []);

  // ─── 更新内容弹窗 ────────────────────────

  const openUpdateNotes = useCallback(() => setShowNotes(true), []);
  const closeUpdateNotes = useCallback(() => setShowNotes(false), []);

  // ─── 「稍后」抑制（按版本号记忆，换版本自动解除）────
  const dismissUpdate = useCallback(() => {
    const v = update?.version;
    if (!v) return;
    try {
      localStorage.setItem(DISMISSED_KEY, v);
    } catch {
      // 存储失败忽略
    }
    setDismissedVersion(v);
  }, [update?.version]);

  const isDismissed = useCallback(
    (version?: string) => {
      if (!version) return false;
      return dismissedVersion === version;
    },
    [dismissedVersion],
  );

  return (
    <UpdateContext.Provider value={{ status, update, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes, restarting, error, checkForUpdate, manualCheckForUpdate, downloadAndInstall, restart, openUpdateNotes, dismissUpdate, isDismissed, manualCheck, acknowledgeUptodate: () => setManualCheck(false) }}>
      {children}
      {/* 下载期窗口级反馈（方案 B + B+，2026-10-16）：2px 通栏进度线 + 28px 网速状态条。
          两者都是 fixed 零占位浮层，挂在 Provider 内部与 UpdateNotesDialog 同级，
          这样折叠态 / 任何页面下都随更新状态出现，不依赖具体页面是否挂载。 */}
      <UpdateProgressBar variant="line" />
      <UpdateProgressBar variant="bar" />
      {restarting && <RestartOverlay current={update?.currentVersion} next={update?.version} />}
      <UpdateNotesDialog open={showNotes} update={update} onClose={closeUpdateNotes} onDownload={downloadAndInstall} onDismiss={dismissUpdate} />
    </UpdateContext.Provider>
  );
}
