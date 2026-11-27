import { useUpdateRestartSafety } from "../hooks/useUpdateRestartSafety";
import { canRestart, meetsUpdateMinimum, type UpdatePresentation } from "../lib/updatePresentation";
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { relaunch, exit } from "@tauri-apps/plugin-process";
import { invoke } from "../lib/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { UpdateNotesDialog } from "../components/update/UpdateNotesDialog";
import { RestartOverlay } from "../components/update/RestartOverlay";

// ─── 类型定义 ────────────────────────────

export type UpdateStatus = "idle" | "uptodate" | UpdatePresentation["status"];

/**
 * 后端 `check_update_policy` 的返回值（见 `commands/update_policy.rs`）。
 *
 * `mandatory` 只会在「远端/缓存策略合法 + enforced + 已过缓冲期 + 当前版本低于门槛」
 * 同时成立时为 true。后端对任何异常都判放行，这里不再做二次判定 —— 两道判定只会
 * 多一个判错的地方。
 */
export interface ForceUpdateVerdict {
  mandatory: boolean;
  currentVersion: string;
  latestVersion?: string | null;
  minSupportedVersion?: string | null;
  message?: string | null;
  graceUntil?: string | null;
  expiresAt?: string | null;
  /** network / cache / network-miss / invalid / skip，仅排查用 */
  source: string;
}

export interface ForceUpdateInfo {
  active: boolean;
  verdict: ForceUpdateVerdict | null;
}

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
  /** Legacy status-consumer compatibility; manual restart keeps this null. */
  autoRestartIn: number | null;
  /** Legacy compatibility; updates no longer schedule automatic restarts. */
  cancelAutoRestart: () => void;
  error: string | null;
  /** 错误原因码（见 `UpdateErrorCode`）；旧后端或未知错误为 null */
  errorCode: string | null;
  /**
   * 本次失败是否该弹 toast。
   *
   * 自动检查（启动自检 / 24 小时定时）失败时**只更新徽章与关于页状态**，不弹红 toast ——
   * 用户什么都没点，不该在开机时收到「更新服务器连不上」的警报（尤其在公司网络封了
   * Gitee/GitHub 的环境里，那会是每天都来一次的噪音）。用户主动点击的检查、以及
   * 下载安装失败，仍然弹。
   */
  errorToastAllowed: boolean;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  cancelPreparation: () => Promise<void>;
  retryUpdate: () => Promise<void>;
  canCancelPreparation: boolean;
  downloadPaused: boolean;
  portable: boolean;
  lastCheckedAt: number | null;
  restart: () => Promise<void>;
  /** 打开「查看更新内容」弹窗 */
  openUpdateNotes: () => void;
  /** 记住当前可用版本为「忽略此版本」：本版本不再弹框（按版本号记忆，换版本自动解除） */
  dismissUpdate: () => void;
  /** 判断某版本是否已被「忽略此版本」抑制 */
  isDismissed: (version?: string) => boolean;
  /** 本次「已是最新」提示是否来自手动检查：自动检查（启动/定时）不弹框，只在版本号 pill 提示 */
  manualCheck: boolean;
  /** 手动检查「已是最新」toast 已消费后复位 manualCheck */
  acknowledgeUptodate: () => void;
  /** 手动触发检查更新（用户主动点击，命中 uptodate 时才弹「已是最新」提示框） */
  manualCheckForUpdate: () => Promise<void>;
  /** 强制更新（最低可用版本）判定结果。`active` 为 true 时显示不可关闭的遮罩。 */
  forceUpdate: ForceUpdateInfo;
  /**
   * 强制态下直接开始下载安装。
   *
   * 与 `downloadAndInstall` 的区别：它不要求 `update` 已有值 —— 强制判定来自策略文件，
   * 此时可能还没跑过一次完整的 `updater.check()`，而用户点「立即更新」不能等。
   */
  startForcedUpdate: () => Promise<void>;
  installPreparedUpdate: () => Promise<void>;
  autoPreload: boolean;
  setAutoPreload: (enabled: boolean) => void;
  refreshForcePolicy: () => Promise<void>;
  checkingPolicy: boolean;
  finishingWork: boolean;
  canFinishWork: boolean;
  workSeconds: number;
  finishCurrentWork: () => void;
  returnToUpdate: () => void;
  /** 退出软件（强制遮罩的逃生口：策略误伤时至少能退出，而不是卡死）。 */
  quitApp: () => Promise<void>;
}

// ─── 友好错误翻译 ────────────────────────

export interface FriendlyError {
  /** 用户友好文案 */
  friendly: string;
  /** 原始错误信息（技术细节） */
  raw: string;
}

/**
 * 后端 `update:error` 的机器可读原因码（Rust 侧 `classify_update_error` 产出）。
 *
 * 为什么要有它：原先只有一段原始英文错误，前端靠 `includes("fetch")` 猜原因。
 * 插件的 manifest 错误文案恰好含 "fetch"，于是「源上 404」被翻译成「你的网络有问题」，
 * 而真正的 `error sending request` 反而落到兜底 —— 两个方向都错（2026-10-22 实测）。
 * 有了 code 之后文案由后端定性、前端只负责措辞。
 */
export type UpdateErrorCode =
  | "manifest"
  | "network"
  | "timeout"
  | "signature"
  | "install"
  | "config"
  | "stale"
  | "unknown";

/** code → 用户文案。键必须与 Rust 侧 `classify_update_error` 的返回值一一对应。 */
const ERROR_TEXT: Record<string, string> = {
  package_size: "更新包超出支持大小，请稍后重试或手动下载安装包",
  manifest: "更新服务器上暂时没有可用的更新信息，请稍后重试",
  network: "无法连接更新服务器，请检查网络或代理设置",
  timeout: "连接更新服务器超时，请稍后重试",
  signature: "更新包校验失败，已阻止安装，请重试",
  install: "更新包安装失败，请重试，或到 GitHub Releases 手动下载",
  config: "更新源配置有误，请检查更新源设置",
  stale: "这个版本刚有变动，请重新检查更新",
  portable: "请下载新版 ZIP，退出软件后替换便携版程序",
};

/**
 * 将原始错误信息拆分为友好提示 + 原始错误。
 *
 * `code` 优先；缺失或为 `unknown` 时回退到字符串启发式（兼容旧后端与未覆盖的错误类型）。
 * 🔴 回退分支的**判断顺序不能换**：具体判定必须排在泛化的 "fetch" 之前，否则插件那句
 * `Could not fetch a valid release JSON from the remote` 又会被当成网络故障。
 */
export function friendlyError(raw: string, code?: string | null): FriendlyError {
  const mapped = code ? ERROR_TEXT[code] : undefined;
  if (mapped) return { friendly: mapped, raw };

  const lower = raw.toLowerCase();
  if (lower.includes("could not fetch a valid release json")) {
    return { friendly: ERROR_TEXT.manifest, raw };
  }
  if (lower.includes("signature") || lower.includes("minisign")) {
    return { friendly: ERROR_TEXT.signature, raw };
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo") || lower.includes("dns")) {
    return { friendly: "无法解析更新服务器地址，请检查网络连接", raw };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { friendly: ERROR_TEXT.timeout, raw };
  }
  if (
    lower.includes("networkerror") ||
    lower.includes("failed to fetch") ||
    lower.includes("error sending request") ||
    lower.includes("connection")
  ) {
    return { friendly: ERROR_TEXT.network, raw };
  }
  if (lower.includes("403") || lower.includes("rate limit")) {
    // 第一候选源是 Gitee，文案不再写死 GitHub。
    return { friendly: "更新服务器拒绝访问（可能触发了限流），请稍后重试", raw };
  }
  return { friendly: "更新失败，请重试", raw };
}

const UpdateContext = createContext<UpdateState | null>(null);

export function useOptionalUpdate() {
  return useContext(UpdateContext);
}

export function useUpdate() {
  const ctx = useOptionalUpdate();
  if (!ctx) throw new Error("useUpdate 必须在 UpdateProvider 内使用");
  return ctx;
}

// ─── 常量 ──────────────────────────────

/** 自动检查间隔：24 小时 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "ccbridge_last_update_check";
const WORK_GRACE_MS = 5 * 60_000;
function readLastCheck(): number | null {
  try {
    const time = Number(localStorage.getItem(LAST_CHECK_KEY));
    return Number.isFinite(time) && time > 0 && time <= Date.now() ? time : null;
  } catch { return null; }
}
/** 「忽略此版本」抑制记忆：记录的版本号（本版本不再弹框，换版本自动解除） */
const DISMISSED_KEY = "ccbridge_dismissed_update_version";
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
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorToastAllowed, setErrorToastAllowed] = useState(true);
  const [restarting, setRestarting] = useState(false);
  // Keep the context contract for existing status consumers; restart is always explicit.
  const autoRestartIn = null;
  const [showNotes, setShowNotes] = useState(false);
  const { safety, refresh: refreshSafety } = useUpdateRestartSafety(showNotes && (status === "ready" || status === "staged"));
  const readyRef = useRef(false);
  const stagedRef = useRef<string | null>(null);
  const installingRef = useRef(false);
  const downloadingRef = useRef(false);
  const interactiveDownloadRef = useRef(false);
  const downloadVersionRef = useRef<string | undefined>(undefined);
  const pausedVersionRef = useRef<string | undefined>(undefined);
  const manualCheckRef = useRef(false);
  const errorSourceRef = useRef<"check" | "download">("check");
  const [downloadPaused, setDownloadPaused] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);
  const [portable, setPortable] = useState(false);
  const portableRef = useRef(false);
  const [lastCheckedAt, setLastCheckedAt] = useState(readLastCheck);
  const cancelPreparation = useCallback(async () => {
    if (!downloadingRef.current || cancellingRef.current) return;
    cancellingRef.current = true;
    setCancelling(true);
    try { await invoke("cancel_update"); }
    catch (e) {
      cancellingRef.current = false;
      setCancelling(false);
      setError(String(e));
    }
  }, []);
  const [autoPreload, setAutoPreloadState] = useState(() => {
    try { return localStorage.getItem("ccbridge_auto_preload_update") !== "false"; }
    catch { return true; }
  });
  const autoPreloadRef = useRef(autoPreload);
  const setAutoPreload = useCallback((enabled: boolean) => {
    autoPreloadRef.current = enabled;
    setAutoPreloadState(enabled);
    try { localStorage.setItem("ccbridge_auto_preload_update", String(enabled)); } catch { /* session preference still applies */ }
    if (!enabled && !interactiveDownloadRef.current) void cancelPreparation();
  }, [cancelPreparation]);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  /**
   * 本次运行中已经自动弹过更新框的版本。
   *
   * 刻意**只存在内存里、不落盘**：
   * - 落盘会让弹框里的「稍后提醒」退化成「这一版永不再提」，与按钮文案不符；
   * - 只记内存 ⇒ 每次启动最多提醒一次，而同一次运行里 24 小时定时再查到同一版本
   *   不会反复弹框打扰。
   * 「忽略此版本」是另一套语义，走 `dismissedVersion`（跨会话持久化）。
   */
  const promptedRef = useRef<string | null>(null);
  /**
   * `dismissedVersion` 的 ref 镜像。
   *
   * 事件监听器只注册一次，闭包里读到的是首帧的 `dismissedVersion`。用户在本次运行
   * 里点了「忽略此版本」后，state 变了但闭包不变 ⇒ 定时检查再收到同一版本会重新弹框。
   * 所以判断必须走 ref，state 只负责驱动 UI。
   */
  const dismissedRef = useRef<string | null>(dismissedVersion);
  const checkingRef = useRef(false);
  const listenersReadyRef = useRef(false);
  const deferredManualCheckRef = useRef(false);
  /** 重启重入防护（与 downloadingRef 同理：state 在同帧内是旧值，挡不住连点） */
  const restartingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptodateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [manualCheck, setManualCheck] = useState(false);
  const [forceVerdict, setForceVerdict] = useState<ForceUpdateVerdict | null>(null);
  /** 监听器里判断「是否处于强制态」必须用 ref：闭包读不到 state 的最新值。 */
  const forceActiveRef = useRef(false);
  const forceMinRef = useRef<string | null>(null);
  const forcedAttemptRef = useRef<string | null>(null);
  const [checkingPolicy, setCheckingPolicy] = useState(false);
  const policyCheckingRef = useRef(false);
  const lastPolicyCheckRef = useRef(0);
  const [finishingWork, setFinishingWork] = useState(false);
  const [workSeconds, setWorkSeconds] = useState(0);
  const [workGraceUsed, setWorkGraceUsed] = useState(false);
  const workDeadlineRef = useRef<number | null>(null);
  const returnToUpdate = useCallback(() => {
    setFinishingWork(false);
  }, []);
  const finishCurrentWork = useCallback(() => {
    if (!forceActiveRef.current) return;
    workDeadlineRef.current ??= Date.now() + WORK_GRACE_MS;
    const remaining = Math.ceil((workDeadlineRef.current - Date.now()) / 1000);
    if (remaining <= 0) return;
    setWorkGraceUsed(true);
    setWorkSeconds(remaining);
    setFinishingWork(true);
  }, []);
  const workGraceActive = workSeconds > 0;
  useEffect(() => {
    if (!workGraceActive) return;
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil(((workDeadlineRef.current ?? 0) - Date.now()) / 1000));
      setWorkSeconds(remaining);
      if (remaining === 0) returnToUpdate();
    }, 1000);
    return () => clearInterval(timer);
  }, [workGraceActive, returnToUpdate]);

  // ─── 强制更新策略（最低可用版本）─────────────
  // 与 check_update 分开：策略文件很小、8 秒超时，判定走返回值而不是事件 ——
  // 前端需要的是「现在要不要锁界面」这个同步结论，不是一串状态推送。
  const checkForcePolicy = useCallback(async () => {
    if (policyCheckingRef.current) return;
    policyCheckingRef.current = true;
    lastPolicyCheckRef.current = Date.now();
    setCheckingPolicy(true);
    try {
      const verdict = await invoke<ForceUpdateVerdict>("check_update_policy");
      const wasForced = forceActiveRef.current;
      forceActiveRef.current = verdict.mandatory === true;
      forceMinRef.current = verdict.mandatory ? verdict.minSupportedVersion ?? null : null;
      setForceVerdict(verdict);
      // 强制遮罩接管画面时，关掉可能已经打开的普通弹框：两者同时 open 时视觉上
      // 是同一块区域（强制层 z=2500 盖在上面），但焦点陷阱是两层，Tab 会串到下层。
      if (verdict.mandatory === true) setShowNotes(false);
      else if (wasForced) {
        forcedAttemptRef.current = null;
        workDeadlineRef.current = null;
        setWorkGraceUsed(false);
        setWorkSeconds(0);
        returnToUpdate();
      }
    } catch (e) {
      // 后端命令按设计只返回 Ok；这里只有 IPC 层异常。按放行处理：启动路径不能因为
      // 一次未知错误把用户挡在门外（与后端 fail-open 同一条原则）。
      console.warn("[Update] 无法刷新强制更新策略:", e);
    } finally {
      policyCheckingRef.current = false;
      setCheckingPolicy(false);
      const version = stagedRef.current;
      if (!forceActiveRef.current && version && version !== dismissedRef.current && version !== promptedRef.current) {
        promptedRef.current = version;
        setShowNotes(true);
      }
    }
  }, [returnToUpdate]);

  useEffect(() => {
    const timer = setInterval(() => void checkForcePolicy(), 5 * 60_000);
    const refreshOnResume = () => {
      if (!document.hidden && Date.now() - lastPolicyCheckRef.current >= 60_000) void checkForcePolicy();
    };
    window.addEventListener("focus", refreshOnResume);
    document.addEventListener("visibilitychange", refreshOnResume);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshOnResume);
      document.removeEventListener("visibilitychange", refreshOnResume);
    };
  }, [checkForcePolicy]);

  useEffect(() => {
    const now = Date.now();
    const timers = [forceVerdict?.graceUntil, forceVerdict?.expiresAt]
      .map(value => Date.parse(value ?? "") - now)
      .filter(delay => delay > 0 && delay < 2 ** 31 - 1)
      .map(delay => setTimeout(() => void checkForcePolicy(), delay));
    return () => timers.forEach(timer => clearTimeout(timer));
  }, [forceVerdict?.graceUntil, forceVerdict?.expiresAt, checkForcePolicy]);

  // ─── 静默检查（不改变 UI 状态，仅内部记录）─────
  // 统一走后端 check_update 命令，状态由事件驱动（update:available / update:uptodate）。

  // ─── 检查更新 ───────────────────────────
  // 统一走后端 check_update 命令；checking/available/uptodate/error 全部由后端事件驱动，
  // 前端不再各自维护一份检查逻辑（避免与 Rust 双真相源）。

  // ─── 检查更新（manual=false 自动/启动/定时；manual=true 用户主动点击）──
  // 自动检查只更新版本号区域状态、不弹「已是最新」提示框；手动检查命中 uptodate 才弹框。
  const runCheck = useCallback(async (manual: boolean, silent = false) => {
    // 下载进行中不接受检查：状态会被打成 checking，而 start_update 内部复查发的
    // checking/available 事件又被监听器的 downloadingRef 守卫吃掉，没有任何事件
    // 能把状态救回来 → 徽章永远停在「检查中」。下载完成后可再查。
    if (!listenersReadyRef.current) {
      if (manual) deferredManualCheckRef.current = true;
      return;
    }
    if (downloadingRef.current || readyRef.current || installingRef.current) {
      if (manual) setShowNotes(true);
      return;
    }
    if (checkingRef.current) {
      if (manual) manualCheckRef.current = true;
      return;
    }
    checkingRef.current = true;
    manualCheckRef.current = manual;
    if (!silent && !stagedRef.current) {
      setStatus("checking");
      setError(null);
      setErrorCode(null);
    }

    try {
      await invoke("check_update");
    } catch (e) {
      if (stagedRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Update] 检查更新失败:", msg);
      setError(msg);
      setErrorCode(null); // invoke 直接 reject 时没有 code，走字符串启发式
      // 只有用户主动点击才弹 toast；启动时「超过 24 小时」的那次自动检查也算自动。
      setErrorToastAllowed(manualCheckRef.current);
      manualCheckRef.current = false;
      errorSourceRef.current = "check";
      setStatus("error");
    } finally {
      checkingRef.current = false;
      const now = Date.now();
      setLastCheckedAt(now);
      try {
        localStorage.setItem(LAST_CHECK_KEY, String(now));
      } catch {
        // 同 silentCheck：写不进只丢「24 小时抑制」，不影响检查本身
      }
    }
  }, []);
  const checkForUpdate = useCallback(() => runCheck(false), [runCheck]);
  const manualCheckForUpdate = useCallback(async () => {
    void checkForcePolicy();
    await runCheck(true);
  }, [checkForcePolicy, runCheck]);

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


  // One preparation path serves both entry points. Only installPreparedUpdate can run an installer.
  const requestPreparation = useCallback(async (interactive: boolean, minimum?: string | null, version?: string) => {
    if (portableRef.current || downloadingRef.current || readyRef.current || installingRef.current) return;
    if (stagedRef.current && meetsUpdateMinimum(stagedRef.current, minimum)) return;
    downloadingRef.current = true;
    stagedRef.current = null;
    interactiveDownloadRef.current = interactive;
    downloadVersionRef.current = version ?? minimum ?? undefined;
    pausedVersionRef.current = undefined;
    setDownloadPaused(false);
    if (minimum) forcedAttemptRef.current = minimum;
    setStatus("downloading");
    setProgress(0);
    setProgressIndeterminate(true);
    setDownloadedBytes(0);
    setTotalBytes(null);
    setBytesPerSec(0);
    setError(null);
    setErrorCode(null);
    try {
      await invoke("start_update", {
        ...(minimum ? { minSupportedVersion: minimum } : {}),
        ...(version ? { requestedVersion: version } : {}),
      });
    } catch (e) {
      downloadingRef.current = false;
      setError(String(e));
      setErrorCode(null);
      setErrorToastAllowed(interactive);
      errorSourceRef.current = "download";
      setStatus("error");
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (update) await requestPreparation(true, forceMinRef.current, update.version);
  }, [update, requestPreparation]);

  const startForcedUpdate = useCallback(
    () => requestPreparation(true, forceMinRef.current), [requestPreparation],
  );
  const retryUpdate = useCallback(async () => {
    if (errorSourceRef.current === "check" || errorCode === "stale") await manualCheckForUpdate();
    else if (forceActiveRef.current) await startForcedUpdate();
    else await downloadAndInstall();
  }, [errorCode, manualCheckForUpdate, startForcedUpdate, downloadAndInstall]);

  useEffect(() => {
    const minimum = forceMinRef.current;
    if (portable || !autoPreload || !forceVerdict?.mandatory || !minimum ||
        forcedAttemptRef.current === minimum || downloadingRef.current ||
        (stagedRef.current && meetsUpdateMinimum(stagedRef.current, minimum))) return;
    void requestPreparation(false, minimum);
  }, [status, forceVerdict, autoPreload, requestPreparation, portable]);

  const installPreparedUpdate = useCallback(async () => {
    const version = stagedRef.current;
    if (!version || installingRef.current || policyCheckingRef.current || !meetsUpdateMinimum(version, forceMinRef.current)) return;
    installingRef.current = true;
    setError(null);
    setErrorCode(null);
    setStatus("installing");
    try {
      const outcome = await invoke<"installed" | "launching" | "busy" | "unavailable">("install_prepared_update", { version });
      if (outcome === "busy") {
        setError("暂时无法安装。请查看当前任务，稍后重试。");
        setStatus("staged");
        await refreshSafety();
      } else if (outcome === "unavailable") {
        stagedRef.current = null;
        setError("本地安装包已失效，请重新准备更新。");
        setErrorCode(null);
        errorSourceRef.current = "download";
        setStatus("error");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("staged");
    } finally {
      installingRef.current = false;
    }
  }, [refreshSafety]);

  /** 强制遮罩的逃生口：策略误伤时用户至少能退出，而不是被永久卡住。 */
  const quitApp = useCallback(async () => {
    try {
      await exit(0);
    } catch (e) {
      console.error("[Update] 退出软件失败:", e);
    }
  }, []);

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
          if (downloadingRef.current || stagedRef.current || readyRef.current || installingRef.current) return;
          setStatus("checking");
          setError(null);
          setErrorCode(null);
        }),
      );
      track(
        await listen<UpdateInfo & { source?: "download" | "check" }>("update:available", (e) => {
          const { source, version, body, date, currentVersion } = e.payload;
          if (source === "download") {
            // 换源后实际下载的版本可能变了，只替换详情，保留下载状态和弹框开关。
            if (!readyRef.current) {
              downloadVersionRef.current = version;
              setUpdate({ version, body, date, currentVersion });
            }
            return;
          }
          if (downloadingRef.current || readyRef.current || installingRef.current) return;
          const manual = manualCheckRef.current;
          // 「手动」标记只对**本次检查**有效，读一次就消费掉。不清掉的话，本次运行里
          // 24 小时定时检查命中同一版本会被误判成手动，绕过下面的去重再弹一次。
          manualCheckRef.current = false;
          if (stagedRef.current && meetsUpdateMinimum(stagedRef.current, version)) {
            if (manual && !forceActiveRef.current && stagedRef.current !== dismissedRef.current) setShowNotes(true);
            return;
          }
          stagedRef.current = null;
          if (pausedVersionRef.current !== version) {
            pausedVersionRef.current = undefined;
            setDownloadPaused(false);
          }
          setStatus("available");
          setUpdate({ version, body, date, currentVersion });

          if (version && autoPreloadRef.current && !portableRef.current && pausedVersionRef.current !== version &&
              (forceActiveRef.current || dismissedRef.current !== version)) {
            if (manual && !forceActiveRef.current) setShowNotes(true);
            void requestPreparation(false, forceMinRef.current, version);
            return;
          }

          // ─── 有更新就弹框（2026-11-26 恢复）─────────────────────────────
          // 两条抑制规则，缺一条都会变成骚扰：
          // 1. `dismissedRef`：用户点过「忽略此版本」⇒ 这个版本永不再弹出（跨会话）。
          // 2. `promptedRef`：同一次运行里同一版本只自动弹一次。用户在弹框里选
          //    「稍后提醒」只是关窗，下次启动会再提醒；选「忽略此版本」才彻底闭嘴。
          // 手动点「检查更新」时无视第 2 条 —— 用户主动问，必须有回应。
          // 强制态由 ForceUpdateGate 接管，普通弹框不再叠一层。
          if (
            !forceActiveRef.current &&
            version &&
            dismissedRef.current !== version &&
            (manual || promptedRef.current !== version)
          ) {
            promptedRef.current = version;
            setShowNotes(true);
          }
        }),
      );
      track(
        await listen("update:downloading", () => {
          if (installingRef.current || readyRef.current) return;
          downloadingRef.current = true;
          setStatus("downloading");
          setProgress(0);
          setProgressIndeterminate(true);
          setBytesPerSec(0);
          setDownloadedBytes(0);
          setTotalBytes(null);
        }),
      );
      track(
        await listen<{ downloaded: number; total: number | null; bytesPerSec?: number }>("update:progress", (e) => {
          const { downloaded, total, bytesPerSec: bps } = e.payload;
          setDownloadedBytes(downloaded);
          // totalBytes 是顶栏读数算「已下载/总量」与「剩余时间」的唯一来源；
          // total 为 null（源未返回 Content-Length）时保持 null ⇒ 读数走不确定态。
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
        await listen("update:cancelled", () => {
          pausedVersionRef.current = downloadVersionRef.current;
          downloadingRef.current = false;
          cancellingRef.current = false;
          setCancelling(false);
          setDownloadPaused(true);
          setError(null);
          setErrorCode(null);
          setStatus("available");
        }),
      );
      track(
        await listen("update:obsolete", () => {
          downloadingRef.current = false;
          cancellingRef.current = false;
          setCancelling(false);
          stagedRef.current = null;
          setStatus("available");
        }),
      );
      track(
        await listen("update:verifying", () => {
          if (downloadingRef.current) setStatus("verifying");
        }),
      );
      track(
        await listen<UpdateInfo & { version: string; size: number }>("update:staged", ({ payload }) => {
          downloadingRef.current = false;
          cancellingRef.current = false;
          setCancelling(false);
          setDownloadPaused(false);
          setError(null);
          setErrorCode(null);
          if (!meetsUpdateMinimum(payload.version, forceMinRef.current)) {
            stagedRef.current = null;
            setStatus("available");
            return;
          }
          stagedRef.current = payload.version;
          const { version, body, currentVersion, date } = payload;
          if (currentVersion) setUpdate({ version, body, currentVersion, date });
          setProgress(100);
          setDownloadedBytes(payload.size);
          setTotalBytes(payload.size);
          setStatus("staged");
          if (!forceActiveRef.current && !policyCheckingRef.current &&
              payload.version !== dismissedRef.current && payload.version !== promptedRef.current) {
            promptedRef.current = payload.version;
            setShowNotes(true);
          }
        }),
      );
      track(
        await listen("update:ready", () => {
          setProgress(100);
          setStatus("ready");
          stagedRef.current = null;
          downloadingRef.current = false;
          readyRef.current = true;
        }),
      );
      track(
        await listen<{ message: string; code?: string; source?: "check" | "download" }>("update:error", (e) => {
          const { message, code, source } = e.payload;
          if (readyRef.current || installingRef.current ||
              (source === "check" && (downloadingRef.current || stagedRef.current))) return;
          console.error("[Update] 更新失败:", code ?? "unknown", message);
          setError(message);
          setErrorCode(code ?? null);
          // 自动检查（启动自检 / 24h 定时）失败只更新状态，不弹红 toast；
          // 用户主动发起的检查与下载失败仍然弹。
          const failedDownload = source === "download" || (source == null && downloadingRef.current);
          errorSourceRef.current = failedDownload ? "download" : "check";
          setErrorToastAllowed(failedDownload ? interactiveDownloadRef.current : manualCheckRef.current);
          // 复位手动标记：不清掉的话，下一次自动检查命中 uptodate 会误弹「已是最新」框。
          manualCheckRef.current = false;
          setStatus("error");
          downloadingRef.current = false;
          cancellingRef.current = false;
          setCancelling(false);
        }),
      );
      track(
        await listen("update:uptodate", () => {
          if (downloadingRef.current || stagedRef.current || readyRef.current || installingRef.current) return;
          // 进入「已是最新」可见状态（版本号 pill 显示）；4 秒后自动回到 idle。
          // 仅手动检查才弹「已是最新」提示框（manualCheck），自动检查（启动/定时）不弹框。
          setStatus("uptodate");
          setUpdate(null);
          setDownloadPaused(false);
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
      const kind = await invoke<string>("update_install_kind").catch(() => null);
      if (cancelled) return;
      portableRef.current = kind === "portable";
      setPortable(portableRef.current);
      void checkForcePolicy();
      const lastCheck = readLastCheck();
      const manual = deferredManualCheckRef.current;
      deferredManualCheckRef.current = false;
      listenersReadyRef.current = true;
      await runCheck(manual, !manual && lastCheck !== null && Date.now() - lastCheck < CHECK_INTERVAL_MS);
    };

    setupListeners().then(() => {
      // cancelled 时不再发起检查（组件已卸载，监听器也已注销）
      if (cancelled) return;
      // 强制策略与普通检查并行：它只决定「要不要锁界面」，不依赖事件监听，但必须
      // 尽早出结果，所以不排在 check_update 后面。
      void doStartupCheck();
    });
    return () => {
      cancelled = true;
      listenersReadyRef.current = false;
      unlisteners.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 重启应用 ────────────────────────

  const restart = useCallback(async () => {
    // 重入防护用 ref 而非 state：state 在同一次渲染里恒为旧值，双击 / 连按 Enter
    // 会在同一帧内拿到两次 `restarting === false` ⇒ 两次 relaunch（双杀进程）。
    // 本文件对下载用的是同一个套路（downloadingRef），保持一致。
    if (restartingRef.current || !readyRef.current) return;
    restartingRef.current = true;
    setError(null);
    setShowNotes(true);
    setRestarting(true);
    try {
      // Check current activity immediately before relaunch so a stale dialog cannot interrupt work.
      if (!canRestart(await refreshSafety())) {
        restartingRef.current = false;
        setRestarting(false);
        return;
      }
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
  }, [refreshSafety]);

  const cancelAutoRestart = useCallback(() => undefined, []);

  // ─── 更新内容弹窗 ────────────────────────

  const openUpdateNotes = useCallback(() => setShowNotes(true), []);
  const closeUpdateNotes = useCallback(() => setShowNotes(false), []);

  // ─── 「忽略此版本」抑制（按版本号记忆，换版本自动解除）────
  const dismissUpdate = useCallback(() => {
    const v = update?.version;
    if (!v) return;
    try {
      localStorage.setItem(DISMISSED_KEY, v);
    } catch {
      // 存储失败忽略
    }
    setDismissedVersion(v);
    // 监听器通过 ref 判断（见 dismissedRef 注释），必须同步更新，否则本次运行里
    // 后续的定时检查还会把刚被忽略的版本弹出来。
    dismissedRef.current = v;
  }, [update?.version]);

  const isDismissed = useCallback(
    (version?: string) => {
      if (!version) return false;
      return dismissedVersion === version;
    },
    [dismissedVersion],
  );

  const forceUpdate: ForceUpdateInfo = {
    active: forceVerdict?.mandatory === true,
    verdict: forceVerdict,
  };

  return (
    <UpdateContext.Provider value={{ status, update, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes, restarting, autoRestartIn, cancelAutoRestart, error, errorCode, errorToastAllowed, checkForUpdate, manualCheckForUpdate, downloadAndInstall, cancelPreparation, retryUpdate, canCancelPreparation: !cancelling, downloadPaused, portable, lastCheckedAt, restart, openUpdateNotes, dismissUpdate, isDismissed, manualCheck, acknowledgeUptodate: () => setManualCheck(false), forceUpdate, startForcedUpdate, quitApp, installPreparedUpdate, autoPreload, setAutoPreload, refreshForcePolicy: checkForcePolicy, checkingPolicy, finishingWork, canFinishWork: !workGraceUsed || workGraceActive, workSeconds, finishCurrentWork, returnToUpdate }}>
      {children}
      {restarting && <RestartOverlay current={update?.currentVersion} next={update?.version} />}
      <UpdateNotesDialog open={showNotes && !forceUpdate.active} update={update}
        process={{ status: status === "idle" || status === "uptodate" ? "available" : status, progress, indeterminate: progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes, error: status === "ready" || status === "staged" ? error : error ? friendlyError(error, errorCode).friendly : null, safety, restarting, downloadPaused }}
        onClose={closeUpdateNotes} onDownload={downloadAndInstall} onDismiss={dismissUpdate}
        onInstall={installPreparedUpdate} onRestart={restart} onRetry={retryUpdate} onRefreshSafety={refreshSafety} checkingPolicy={checkingPolicy}
        onCancelDownload={cancelPreparation} cancelling={cancelling} portable={portable} />
    </UpdateContext.Provider>
  );
}
