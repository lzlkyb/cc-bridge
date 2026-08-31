import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../../lib/tauri";
import { toast } from "../ui/toast";

/**
 * 与后端 `ssh_cmds.rs` 的错误前缀常量一一对应。**改一边必须改另一边。**
 *
 * 🔴 用前缀而不是匹配中文文案：文案会改，前缀不会。
 * 「取消」「超时」「失败」在 UI 上必须可区分，靠字串包含去猜必然跑偏。
 */
const ERR_CANCELLED = "CCB_CANCELLED";
const ERR_TARGET_EXISTS = "CCB_TARGET_EXISTS";

/** EMA 平滑系数：scp 的刷新间隔不均匀，直接用瞬时值算 ETA 会剧烈跳动。 */
const ETA_SMOOTHING = 0.7;

export type TransferKind = "up" | "down";

export interface TransferState {
  kind: TransferKind;
  name: string;
  /** null = 拿不到百分比（握手/认证阶段），UI 显示不定量条。 */
  percent: number | null;
  /** 剩余秒数，null = 还算不出。 */
  eta: number | null;
}

/** 覆盖确认：由调用方渲染对话框，确认后调 `confirm()` 重跑一次。 */
export interface OverwritePrompt {
  kind: TransferKind;
  path: string;
  confirm: () => void;
  /** 用户放弃：让等待中的 Promise 以 false 收尾，避免调用方永远悬着。 */
  cancel: () => void;
}

/**
 * 清理 SFTP 报错里的 PTY 噪声：scp/ssh 在 PTY 下会输出 `\r` 进度条、ANSI 转义、
 * 多余空行。剥掉后只留人类可读的错误（权限拒绝 / 路径不存在 / 连接失败等）。
 */
export function cleanErr(raw: unknown): string {
  const s = String(raw ?? "");
  return s
    .replace(/\[[0-9;]*m/g, "") // ANSI 颜色
    .replace(/[\r]/g, "") // 回车 / 退格（进度条覆盖）
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-6) // 只取末尾关键几行
    .join("\n")
    .trim();
}

interface StartArgs {
  connectionId: string;
  /** 展示用的文件名。 */
  name: string;
  remote: string;
  local: string;
}

/**
 * SFTP 传输编排：进度、取消、覆盖确认。
 *
 * 拆成 hook 而不是写进 `SshFileBrowser`，是因为后者已经 297 行，靠近
 * 项目规则的 300 行上限。
 */
export function useSshTransfer() {
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [prompt, setPrompt] = useState<OverwritePrompt | null>(null);
  // 当前传输 id。用 ref 而非 state：事件回调里要读到最新值，
  // 而 listen 只注册一次，闭包住 state 会拿到陈旧值。
  const idRef = useRef<string | null>(null);
  const lastRef = useRef<{ t: number; p: number } | null>(null);
  const etaRef = useRef<number | null>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void listen<{ transferId: string; percent: number }>(
      "ssh_transfer_progress",
      (e) => {
        // 只认当前这一次：上一次传输的尾巴事件不能污染新的进度条。
        if (e.transferId !== idRef.current) return;
        const now = Date.now();
        const prev = lastRef.current;
        lastRef.current = { t: now, p: e.percent };
        if (prev && e.percent > prev.p) {
          const perSec = (e.percent - prev.p) / ((now - prev.t) / 1000);
          if (perSec > 0) {
            const raw = (100 - e.percent) / perSec;
            etaRef.current =
              etaRef.current == null
                ? raw
                : etaRef.current * ETA_SMOOTHING + raw * (1 - ETA_SMOOTHING);
          }
        }
        setTransfer((t) =>
          t ? { ...t, percent: e.percent, eta: etaRef.current } : t,
        );
      },
    ).then((f) => {
      if (dead) f();
      else off = f;
    });
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  const begin = (kind: TransferKind, name: string) => {
    const id = crypto.randomUUID();
    idRef.current = id;
    lastRef.current = null;
    etaRef.current = null;
    setTransfer({ kind, name, percent: null, eta: null });
    return id;
  };

  const end = () => {
    idRef.current = null;
    setTransfer(null);
  };

  /** 取消当前传输。后端只置位标志，真正终止在 ≤200ms 后发生。 */
  const cancel = useCallback(() => {
    const id = idRef.current;
    if (id) void invoke("ssh_sftp_cancel", { transferId: id }).catch(() => {});
  }, []);

  /** 失败分流：取消 / 真失败，文案不能混。 */
  const report = (raw: unknown, kind: TransferKind, name: string) => {
    const s = String(raw ?? "");
    if (s.includes(ERR_CANCELLED)) {
      if (kind === "up") {
        // 设计稿 §3：不自动删远端残留（可能是覆盖上传，那文件本来就是用户的），
        // 但必须明确告知，不能静默。
        toast(`已取消上传。远端可能留下不完整的 ${name}，请自行确认`, "warning");
      } else {
        toast("已取消下载", "info");
      }
      return;
    }
    toast(`${kind === "up" ? "上传" : "下载"}失败：${cleanErr(s)}`, "error");
  };

  /**
   * 关闭覆盖确认框。必须走 `prompt.cancel()` 而不是直接 `setPrompt(null)`，
   * 否则等待中的 Promise 会永远不结束（上层的表单就永远关不掉）。
   *
   * 不能写成 `setPrompt(p =&gt; { p?.cancel(); return null; })`：StrictMode 下
   * updater 会被双调，而 `cancel` 内部又会 `setPrompt`，就嵌套更新了。
   */
  const dismissPrompt = useCallback(() => {
    prompt?.cancel();
  }, [prompt]);

  /**
   * 下载。目标已存在且未授权覆盖时，后端拒绝并返回 `CCB_TARGET_EXISTS`，
   * 此时**不弹错误**，而是置一个覆盖确认提示，用户确认后带 overwrite 重跑。
   */
  const download = useCallback(async (a: StartArgs): Promise<boolean> => {
    // 三态返回而不是在 catch 里直接 await 弹框：那样 `finally { end() }` 会拖到
    // 对话框关闭之后才执行，进度条会一直挂在确认框后面不消失。
    const run = async (
      overwrite: boolean,
    ): Promise<"ok" | "exists" | "fail"> => {
      const id = begin("down", a.name);
      try {
        await invoke("ssh_sftp_get", {
          connectionId: a.connectionId,
          remote: a.remote,
          local: a.local,
          transferId: id,
          overwrite,
        });
        toast(`已下载：${a.name}`, "success");
        return "ok";
      } catch (e) {
        if (!overwrite && String(e ?? "").includes(ERR_TARGET_EXISTS)) {
          return "exists";
        }
        report(e, "down", a.name);
        return "fail";
      } finally {
        end();
      }
    };

    const first = await run(false);
    if (first !== "exists") return first === "ok";
    return new Promise<boolean>((resolve) => {
      setPrompt({
        kind: "down",
        path: a.local,
        confirm: () => {
          setPrompt(null);
          void run(true).then((r) => resolve(r === "ok"));
        },
        cancel: () => {
          setPrompt(null);
          resolve(false);
        },
      });
    });
  }, []);

  /**
   * 上传。重名判定在**前端**（调用方传 `remoteExists`）：当前目录的 entries
   * 前端手里已经有，在后端再查一次就多一次完整的 ssh 握手。
   */
  const upload = useCallback(
    async (a: StartArgs & { remoteExists: boolean }): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        const id = begin("up", a.name);
        try {
          await invoke("ssh_sftp_put", {
            connectionId: a.connectionId,
            local: a.local,
            remote: a.remote,
            transferId: id,
          });
          toast(`已上传：${a.name}`, "success");
          return true;
        } catch (e) {
          report(e, "up", a.name);
          return false;
        } finally {
          end();
        }
      };
      if (a.remoteExists) {
        return new Promise((resolve) => {
          setPrompt({
            kind: "up",
            path: a.remote,
            confirm: () => {
              setPrompt(null);
              void run().then(resolve);
            },
            cancel: () => {
              setPrompt(null);
              resolve(false);
            },
          });
        });
      }
      return run();
    },
    [],
  );

  return {
    transfer,
    prompt,
    dismissPrompt,
    download,
    upload,
    cancel,
  };
}
