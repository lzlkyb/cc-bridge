import { useCallback } from "react";
import { dirname, join } from "@tauri-apps/api/path";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { cleanErr } from "../../lib/utils";
// 错误前缀协议（与后端 ssh_cmds.rs 一一对应）统一放 lib/sshErrors.ts。
import { isCancelled, isTargetExists } from "../../lib/sshErrors";
import type { StartArgs } from "../../lib/transferTypes";
import { useTransferCore, type TransferCore } from "./useTransferCore";
import { downloadMany, putMany } from "./batchTransfer";
import { queueSshTransfer } from "../../lib/sshTransferQueue";
import { copyUploadName, joinRemotePath, remoteParentPath } from "../../lib/sshFilePaths";

/**
 * SFTP 传输编排（**单文件**）：下载 / 上传各一条链路，含覆盖确认。
 *
 * 2026-11-17：传输态与批量链路已搬走——
 * - 状态、进度监听、取消、失败分流、覆盖提问 → `useTransferCore.ts`
 * - 批量下载/上传（多源 scp 合并）→ `batchTransfer.ts`（纯编排）
 * 本文件只剩单文件的两条链路与对批量的薄委派。原 303 行已超体量门禁登记基线
 * （只许变小），拆分后回落到限制内。
 */
export function useSshTransfer() {
  const core = useTransferCore();

  /**
   * 下载。目标已存在且未授权覆盖时，后端拒绝并返回 `CCB_TARGET_EXISTS`，
   * 此时**不弹错误**，而是置一个覆盖确认提示，用户确认后带 overwrite 重跑。
   */
  const download = useCallback(
    async (a: StartArgs, onFailure?: (message: string) => void): Promise<boolean> => {
      const run = async (overwrite: boolean, destination = a.local): Promise<"ok" | "exists" | "fail"> => {
        const id = core.begin("down", a.name, undefined, undefined, destination === a.local ? a.transferId : undefined);
        try {
          await queueSshTransfer({ id, connectionId: a.connectionId, direction: "down", label: a.name, target: destination, resumable: true, confirmConflict: !overwrite }, () => invoke("ssh_sftp_get", {
            connectionId: a.connectionId,
            remote: a.remote,
            local: destination,
            transferId: id,
            overwrite,
            resumable: true,
          }));
          toast(`已下载：${a.name}`, "success");
          return "ok";
        } catch (e) {
          if (!overwrite && isTargetExists(e)) {
            return "exists";
          }
          if (!isCancelled(e)) onFailure?.(cleanErr(e));
          core.report(e, "down", a.name);
          return "fail";
        } finally {
          core.end();
        }
      };
      // The native picker returns a path only. The file may first appear while the job is queued.
      const first = await run(false);
      if (first !== "exists") return first === "ok";
      const decision = await core.askOverwrite({ kind: "down", path: a.local, names: [a.name], keepBoth: true });
      if (decision === "keepBoth") return (await run(false, await join(await dirname(a.local), copyUploadName(a.name)))) === "ok";
      if (decision !== "overwrite") return false;
      return (await run(true)) === "ok";
    },
    [core],
  );

  /**
   * 传一个文件（含覆盖确认）。返回三态而不是 bool：
   * 批量上传必须能分辨「用户取消」与「传失败」，否则只能瞎猜要不要继续。
   */
  const putOne = useCallback(async (
    a: StartArgs & { index?: number; total?: number },
    remoteExists: boolean,
    /** 批量上传时置 true：逐条 success toast 会刷屏，改由调用方汇总告知。 */
    silent = false,
  ): Promise<"ok" | "cancelled" | "fail"> => {
    const run = async (name = a.name, remote = a.remote, overwrite = false): Promise<"ok" | "cancelled" | "fail"> => {
      const id = core.begin("up", name, a.index, a.total);
      try {
        await queueSshTransfer({ id, connectionId: a.connectionId, direction: "up", label: name, target: remote, resumable: true }, () => invoke("ssh_sftp_put", {
          connectionId: a.connectionId,
          local: a.local,
          remote,
          transferId: id,
          overwrite,
          resumable: true,
        }));
        if (!silent) toast(`已上传：${name}`, "success");
        return "ok";
      } catch (e) {
        core.report(e, "up", a.name);
        return isCancelled(e) ? "cancelled" : "fail";
      } finally {
        core.end();
      }
    };
    if (!remoteExists) return run();
    const decision = await core.askOverwrite({ kind: "up", path: a.remote, names: [a.name] });
    if (decision === "keepBoth") {
      const name = copyUploadName(a.name);
      return run(name, joinRemotePath(remoteParentPath(a.remote), name));
    }
    if (decision !== "overwrite") return "cancelled";
    return run(a.name, a.remote, true);
  }, [core]);

  /**
   * 上传。重名判定在**前端**（调用方传 `remoteExists`）：当前目录的 entries
   * 前端手里已经有，在后端再查一次就多一次完整的 ssh 握手。
   */
  const upload = useCallback(
    async (a: StartArgs & { remoteExists: boolean }): Promise<boolean> => {
      const r = await putOne(a, a.remoteExists);
      return r === "ok";
    },
    [putOne],
  );

  return {
    ...core,
    download,
    upload,
    putOne,
    /** 批量下载：调用方已选好目标目录（后端按 local 目录分组多源 scp）。 */
    downloadMany: (a: Parameters<typeof downloadMany>[1]) => downloadMany(core, a),
    /** 批量上传（拖拽 + 面板批量）：同名一次问完，随后一次多源 scp。 */
    uploadMany: (a: Parameters<typeof putMany>[1]) => putMany(core, a),
  };
}

/** 供只引用类型的地方使用（避免循环 import 值）。 */
export type SshTransfer = ReturnType<typeof useSshTransfer>;
/** 批量入口的参数类型（转口，省得消费方直接 import 纯模块）。 */
export type DownloadManyArgs = Parameters<typeof downloadMany>[1];
export type UploadManyArgs = Parameters<typeof putMany>[1];
export type { TransferCore };
