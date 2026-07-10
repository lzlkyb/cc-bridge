import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "../lib/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ─── 类型定义 ────────────────────────────

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "uptodate";

export interface UpdateState {
  status: UpdateStatus;
  update: Update | null;
  /** 下载进度 0-100 */
  progress: number;
  error: string | null;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restart: () => Promise<void>;
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

/** 带指数退避的重试执行，最多 retries 次，间隔 1s/2s/4s/... */
async function retryWithBackoff<T>(fn: () => Promise<T>, retries: number, label: string): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`[Update] ${label} 失败（第 ${attempt + 1}/${retries + 1} 次），${delay / 1000}s 后重试:`, e);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// ─── Provider ────────────────────────────

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const checkingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptodateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── 静默检查（不改变 UI 状态，仅内部记录）─────

  const silentCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const u = await check();
      if (u) {
        setStatus("available");
        setUpdate(u);
      }
    } catch {
      // 静默检查失败不处理
    } finally {
      checkingRef.current = false;
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    }
  }, []);

  // ─── 检查更新 ───────────────────────────

  const checkForUpdate = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setStatus("checking");
    setError(null);

    try {
      const u = await retryWithBackoff(() => check(), 3, "检查更新");
      if (u) {
        setStatus("available");
        setUpdate(u);
      } else {
        setStatus("uptodate");
        setUpdate(null);
        if (uptodateTimerRef.current) clearTimeout(uptodateTimerRef.current);
        uptodateTimerRef.current = setTimeout(() => setStatus("idle"), 4000);
      }
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

  const downloadAndInstall = useCallback(async () => {
    if (!update) return;
    invoke("start_update").catch((e) => {
      console.error("[Update] start_update invoke 失败:", e);
      setError(String(e));
      setStatus("error");
    });
  }, [update]);

  // ─── 监听后台更新事件 ────────────────────

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    const setupListeners = async () => {
      unlisteners.push(
        await listen("update:checking", () => {
          setStatus("checking");
          setError(null);
        }),
      );
      unlisteners.push(
        await listen<{ version: string; body: string | null }>("update:available", (e) => {
          setStatus("available");
          setUpdate({ version: e.payload.version, body: e.payload.body } as Update);
        }),
      );
      unlisteners.push(
        await listen("update:downloading", () => {
          setStatus("downloading");
          setProgress(0);
        }),
      );
      unlisteners.push(
        await listen<{ downloaded: number; total: number | null }>("update:progress", (e) => {
          const { downloaded, total } = e.payload;
          if (total) setProgress(Math.round((downloaded / total) * 100));
        }),
      );
      unlisteners.push(
        await listen("update:ready", () => {
          setProgress(100);
          setStatus("ready");
        }),
      );
      unlisteners.push(
        await listen<{ message: string }>("update:error", (e) => {
          console.error("[Update] 更新失败:", e.payload.message);
          setError(e.payload.message);
          setStatus("error");
        }),
      );
      unlisteners.push(
        await listen("update:uptodate", () => {
          setStatus("idle");
          setUpdate(null);
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

  return (
    <UpdateContext.Provider value={{ status, update, progress, error, checkForUpdate, downloadAndInstall, restart }}>
      {children}
    </UpdateContext.Provider>
  );
}
