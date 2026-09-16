import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { joinRemoteDir } from "../../lib/uploadDir";
import { cleanErr } from "../../lib/utils";
// 错误前缀协议（与后端 ssh_cmds.rs 一一对应）统一放 lib/sshErrors.ts。
import { isCancelled, isTargetExists } from "../../lib/sshErrors";
import type { StartArgs, TransferKind, TransferState } from "../../lib/transferTypes";
import { useTransferPrompt } from "./useTransferPrompt";

/** EMA 平滑系数：scp 的刷新间隔不均匀，直接用瞬时值算 ETA 会剧烈跳动。 */
const ETA_SMOOTHING = 0.7;

/**
 * SFTP 传输编排：进度、取消、覆盖确认。
 *
 * 拆成 hook 而不是写进 `SshFileBrowser`，是因为后者已经 297 行，靠近
 * 项目规则的 300 行上限。
 *
 * 2026-09-16：类型契约搬到 `lib/transferTypes.ts`，覆盖确认的提问编排搬到
 * `useTransferPrompt.ts`。本文件现在只管「进度事件 + 传输执行」两件事，
 * 三条链路（下载 / 单个上传 / 批量上传）各自只表达自己关心的东西。
 */
export function useSshTransfer() {
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

  // begin / end / report 都包成稳定引用：它们只用到 setState 与 ref（本身就稳定），
  // 但不包的话，下面每个 useCallback 的依赖数组都得把它们列进去，
  // 而它们每次渲染都是新函数 —— 等于所有回调都失去记忆化。
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

  /**
   * 下载。目标已存在且未授权覆盖时，后端拒绝并返回 `CCB_TARGET_EXISTS`，
   * 此时**不弹错误**，而是置一个覆盖确认提示，用户确认后带 overwrite 重跑。
   */
  const download = useCallback(
    async (a: StartArgs): Promise<boolean> => {
      // 三态返回而不是在 catch 里直接 await 弹框：那样 `finally { end() }` 会拖到
      // 对话框关闭之后才执行，进度条会一直挂在确认框后面不消失。
      const run = async (overwrite: boolean): Promise<"ok" | "exists" | "fail"> => {
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
          if (!overwrite && isTargetExists(e)) {
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
      const decision = await askOverwrite({ kind: "down", path: a.local, names: [a.name] });
      if (decision !== "overwrite") return false;
      return (await run(true)) === "ok";
    },
    [begin, end, report, askOverwrite],
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
    const run = async (): Promise<"ok" | "cancelled" | "fail"> => {
      const id = begin("up", a.name, a.index, a.total);
      try {
        await invoke("ssh_sftp_put", {
          connectionId: a.connectionId,
          local: a.local,
          remote: a.remote,
          transferId: id,
        });
        if (!silent) toast(`已上传：${a.name}`, "success");
        return "ok";
      } catch (e) {
        report(e, "up", a.name);
        return isCancelled(e) ? "cancelled" : "fail";
      } finally {
        end();
      }
    };
    if (!remoteExists) return run();
    const decision = await askOverwrite({ kind: "up", path: a.remote, names: [a.name] });
    // 放弃覆盖 = 主动取消，批量时应当停下来而不是接着闷头传下一个。
    if (decision !== "overwrite") return "cancelled";
    return run();
  }, [begin, end, report, askOverwrite]);

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

  /**
   * 批量上传（拖拽入口）。**顺序**跑，没改现有的一次一个传输模型。
   *
   * 🔴 `existing` 不传时会**先列一次目标目录**。现有的上传重名检查是靠调用方
   * 手里的 entries 比对的（见 `upload` 的注释），而**终端拖拽时手里根本没有目标
   * 目录的列表**——不补这一次列目录，拖拽上传就是**静默覆盖**远端同名文件；
   * 删除有二次确认、覆盖却悄无声息，两者丢数据的后果是一样的。
   * 这一次列目录现在很便宜（helper 常驻会话），顺便也确认了目标目录真实存在。
   */
  const uploadMany = useCallback(
    async (a: {
      connectionId: string;
      dir: string;
      files: { local: string; name: string }[];
      existing?: string[];
    }): Promise<{ done: number; total: number }> => {
      const total = a.files.length;
      if (total === 0) return { done: 0, total: 0 };

      let names = a.existing;
      if (names === undefined) {
        try {
          const entries = await invoke<{ name: string }[]>("ssh_sftp_list", {
            connectionId: a.connectionId,
            path: a.dir,
          });
          // 软链条目的 name 带 ` -> target` 后缀，比对前先截掉。
          names = entries.map((e) => e.name.split(" -> ")[0]);
        } catch (e) {
          toast(`目标目录无法访问：${cleanErr(e)}`, "error");
          return { done: 0, total };
        }
      }
      const existingSet = new Set(names);

      // 🔴 同名**一次问完**，不在循环里逐个弹。原来每个同名文件各弹一次，拖 5 个同名
      // 文件就要点 5 次——和「多行粘贴逐个确认」是同一类设计错误：用高频打断去换一个
      // 低频风险。这里给出一次全局选择，循环内不再问。
      //
      // 清单先去重：一次拖入 `a/x.txt` 与 `b/x.txt` 时 base name 相同，重复项会让
      // 对话框列出两个 "x.txt"（React key 冲突）并把数量报成 2。
      const conflicts = [
        ...new Set(a.files.map((f) => f.name).filter((n) => existingSet.has(n))),
      ];
      let skipSet: Set<string> | null = null;
      if (conflicts.length > 0) {
        const decision = await askOverwrite({
          kind: "up",
          path: a.dir,
          names: conflicts,
          skippable: true,
        });
        if (decision === "cancel") return { done: 0, total };
        if (decision === "skip") {
          skipSet = new Set(conflicts);
          // 全部同名且选了跳过 → 循环一次都不进、done 恒为 0，而调用方是「done>0 才提示」
          // （终端拖拽挂结果条、文件面板只刷新列表）→ 用户点了按钮却什么都没发生。
          // 这里明确交代一句，不让这个分支静默收场。
          if (conflicts.length === total) {
            toast(`已跳过全部 ${total} 个同名文件，未上传`, "info");
          }
        }
      }

      let done = 0;
      for (let i = 0; i < total; i++) {
        const f = a.files[i];
        // 用户选了「跳过同名」：这些原样不动，其余照传。
        if (skipSet?.has(f.name)) continue;
        // 覆盖与否上面已经问过，循环里不再弹（`false`）；
        // `silent` 让逐条 success toast 闭嘴——汇总由调用方给（终端拖拽有结果条，
        // 文件面板靠传完刷新列表）。
        const r = await putOne(
          {
            connectionId: a.connectionId,
            name: f.name,
            local: f.local,
            remote: joinRemoteDir(a.dir, f.name),
            index: i + 1,
            total,
          },
          false,
          true,
        );
        if (r !== "ok") {
          const left = total - i - 1;
          if (left > 0) toast(`已停下，还有 ${left} 个文件未上传`, "warning");
          return { done, total };
        }
        done++;
      }
      return { done, total };
    },
    [putOne, askOverwrite],
  );

  return {
    transfer,
    prompt,
    dismissPrompt,
    download,
    upload,
    uploadMany,
    cancel,
  };
}
