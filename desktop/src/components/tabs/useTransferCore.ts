import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { cleanErr } from "../../lib/utils";
// 错误前缀协议（与后端 ssh_cmds.rs 一一对应）统一放 lib/sshErrors.ts。
import { isCancelled } from "../../lib/sshErrors";
import type { TransferKind, TransferState } from "../../lib/transferTypes";
import { useTransferPrompt } from "./useTransferPrompt";

/** EMA 平滑系数：scp 的刷新间隔不均匀，直接用瞬时值算 ETA 会剧烈跳动。 */
const ETA_SMOOTHING = 0.7;

/**
 * 传输态核心：进度事件监听 + 传输生命周期（begin/end/cancel）+ 失败分流 + 覆盖确认。
 *
 * 2026-11-17：从 `useSshTransfer.ts` 抽出。原因：批量传输（多源 scp 合并）也要用
 * 同一套传输态——一次批量下载就是一个 transfer id、一条进度条。而 `useSshTransfer`
 * 已超组件体量门禁的登记基线（303 行，只许变小），把共有部分搬出来，
 * 单文件链路与批量链路都变薄，才能既加功能又不涨基线。
 *
 * 它**不包含**任何具体传输逻辑（下载/上传怎么调 invoke），那些在
 * `useSshTransfer`（单文件）与 `batchTransfer.ts`（批量，纯编排）里。
 */
export function useTransferCore() {
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const { prompt, dismissPrompt, askOverwrite } = useTransferPrompt();
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
                : etaRef.current * ETA_SMOOTHING + (1 - ETA_SMOOTHING) * raw;
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

  // begin / end / report 都包成稳定引用：它们只用到 setState 与 ref（本身就稳定），
  // 但不包的话，依赖数组每次渲染都得把它们列进去，等于所有回调都失去记忆化。
  const begin = useCallback((
    kind: TransferKind,
    name: string,
    index?: number,
    total?: number,
  ) => {
    const id = crypto.randomUUID();
    idRef.current = id;
    lastRef.current = null;
    etaRef.current = null;
    setTransfer({ kind, name, percent: null, eta: null, index, total });
    return id;
  }, []);

  const end = useCallback(() => {
    idRef.current = null;
    setTransfer(null);
  }, []);

  /** 取消当前传输。后端只置位标志，真正终止在 ≤200ms 后发生。 */
  const cancel = useCallback(() => {
    const id = idRef.current;
    if (id) void invoke("ssh_sftp_cancel", { transferId: id }).catch(() => {});
  }, []);

  /** 失败分流：取消 / 真失败，文案不能混。 */
  const report = useCallback((raw: unknown, kind: TransferKind, name: string) => {
    if (isCancelled(raw)) {
      if (kind === "up") {
        // 设计稿 §3：不自动删远端残留（可能是覆盖上传，那文件本来就是用户的），
        // 但必须明确告知，不能静默。
        toast(`已取消上传。远端可能留下不完整的 ${name}，请自行确认`, "warning");
      } else {
        toast("已取消下载", "info");
      }
      return;
    }
    toast(`${kind === "up" ? "上传" : "下载"}失败：${cleanErr(raw)}`, "error");
  }, []);

  return { transfer, prompt, dismissPrompt, askOverwrite, begin, end, cancel, report };
}

/** `useTransferCore` 的返回：批量编排（`batchTransfer.ts`）依赖的契约。 */
export type TransferCore = ReturnType<typeof useTransferCore>;
