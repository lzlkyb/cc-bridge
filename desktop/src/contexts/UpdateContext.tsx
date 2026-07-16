import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "../lib/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { UpdateNotesDialog } from "../components/update/UpdateNotesDialog";

// ─── 类型定义 ────────────────────────────

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "uptodate";

/** 更新信息（由后端 check_update / start_update 通过事件推送，仅含展示所需字段，不再依赖插件 Update 对象） */
export interface UpdateInfo {
  version?: string;
  body?: string | null;
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
  error: string | null;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restart: () => Promise<void>;
  /** 打开「查看更新内容」弹窗 */
  openUpdateNotes: () => void;
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

// ─── Provider ────────────────────────────

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressIndeterminate, setProgressIndeterminate] = useState(false);
  const [bytesPerSec, setBytesPerSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const checkingRef = useRef(false);
  const downloadingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptodateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const checkForUpdate = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
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

  // ─── 启动时自动检查 ──────────────────────

  useEffect(() => {
    const doStartupCheck = async () => {
      const lastCheck = localStorage.getItem(LAST_CHECK_KEY);
      const now = Date.now();
      if (lastCheck && now - Number(lastCheck) < CHECK_INTERVAL_MS) {
        await silentCheck();
        return;
      }
      await checkForUpdate();
    };
    doStartupCheck();

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
    const unlisteners: UnlistenFn[] = [];

    const setupListeners = async () => {
      unlisteners.push(
        await listen("update:checking", () => {
          // 下载进行中（start_update 内部复查也会发 checking），不回退状态
          if (downloadingRef.current) return;
          setStatus("checking");
          setError(null);
        }),
      );
      unlisteners.push(
        await listen<{ version: string; body: string | null }>("update:available", (e) => {
          // 下载进行中（start_update 内部复查会再发 available），保持 downloading 不被回退
          if (downloadingRef.current) return;
          setStatus("available");
          setUpdate({ version: e.payload.version, body: e.payload.body });
        }),
      );
      unlisteners.push(
        await listen("update:downloading", () => {
          setStatus("downloading");
          setProgress(0);
          setProgressIndeterminate(false);
          setBytesPerSec(0);
        }),
      );
      unlisteners.push(
        await listen<{ downloaded: number; total: number | null; bytesPerSec?: number }>("update:progress", (e) => {
          const { downloaded, total, bytesPerSec: bps } = e.payload;
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
      unlisteners.push(
        await listen("update:ready", () => {
          setProgress(100);
          setStatus("ready");
          downloadingRef.current = false;
        }),
      );
      unlisteners.push(
        await listen<{ message: string }>("update:error", (e) => {
          console.error("[Update] 更新失败:", e.payload.message);
          setError(e.payload.message);
          setStatus("error");
          downloadingRef.current = false;
        }),
      );
      unlisteners.push(
        await listen("update:uptodate", () => {
          // 进入「已是最新」可见状态（原本被误重置为 idle，导致 pill/toast 永不触发）。
          // 4 秒后自动回到 idle；先清旧定时器防重入（如连续多次检查命中）。
          setStatus("uptodate");
          setUpdate(null);
          if (uptodateTimerRef.current) clearTimeout(uptodateTimerRef.current);
          uptodateTimerRef.current = setTimeout(() => {
            setStatus((s) => (s === "uptodate" ? "idle" : s));
          }, 4000);
        }),
      );
    };

    setupListeners();
    return () => unlisteners.forEach((fn) => fn());
  }, []);

  // ─── 重启应用 ────────────────────────────

  const restart = useCallback(async () => {
    try {
      await relaunch();
    } catch (e) {
      console.error("[Update] 重启失败:", e);
    }
  }, []);

  // ─── 更新内容弹窗 ────────────────────────

  const openUpdateNotes = useCallback(() => setShowNotes(true), []);
  const closeUpdateNotes = useCallback(() => setShowNotes(false), []);

  return (
    <UpdateContext.Provider value={{ status, update, progress, progressIndeterminate, bytesPerSec, error, checkForUpdate, downloadAndInstall, restart, openUpdateNotes }}>
      {children}
      <UpdateNotesDialog open={showNotes} update={update} onClose={closeUpdateNotes} onDownload={downloadAndInstall} />
    </UpdateContext.Provider>
  );
}
