import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { joinRemoteDir } from "../../lib/uploadDir";
import { cleanErr } from "../../lib/utils";
// 错误前缀协议（与后端 ssh_cmds.rs 一一对应）统一放 lib/sshErrors.ts。
import { isCancelled, isTargetExists } from "../../lib/sshErrors";

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
  /** 批量上传时的序号（从 1 起）与总数；单个传输时为 undefined。 */
  index?: number;
  total?: number;
}

/** 覆盖确认：由调用方渲染对话框，确认后调 `confirm()` 重跑一次。 */
export interface OverwritePrompt {
  kind: TransferKind;
  path: string;
  confirm: () => void;
  /** 用户放弃：让等待中的 Promise 以 false 收尾，避免调用方永远悬着。 */
  cancel: () => void;
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
  }, [begin, end, report]);

  /**
   * 传一个文件（含覆盖确认）。返回三态而不是 bool：
   * 批量上传必须能分辨「用户取消」与「传失败」，否则只能瞎猜要不要继续。
   */
  const putOne = useCallback(async (
    a: StartArgs & { index?: number; total?: number },
    remoteExists: boolean,
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
        toast(`已上传：${a.name}`, "success");
        return "ok";
      } catch (e) {
        report(e, "up", a.name);
        return isCancelled(e) ? "cancelled" : "fail";
      } finally {
        end();
      }
    };
    if (!remoteExists) return run();
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
          // 放弃覆盖 = 主动取消，批量时应当停下来而不是接着闷头传下一个。
          resolve("cancelled");
        },
      });
    });
  }, [begin, end, report]);

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

      for (let i = 0; i < total; i++) {
        const f = a.files[i];
        const r = await putOne(
          {
            connectionId: a.connectionId,
            name: f.name,
            local: f.local,
            remote: joinRemoteDir(a.dir, f.name),
            index: i + 1,
            total,
          },
          existingSet.has(f.name),
        );
        if (r !== "ok") {
          const left = total - i - 1;
          if (left > 0) toast(`已停下，还有 ${left} 个文件未上传`, "warning");
          return { done: i, total };
        }
        // 🔴 传完就要计入「已存在」。否则一次拖入 `a/x.txt` 与 `b/x.txt` 时，
        // 第二个在开头那次列目录里确实不存在 → 不弹覆盖确认 → 直接盖掉刚传上去的
        // 那个，最后还报「已上传 2 个文件」而远端只有一个。
        existingSet.add(f.name);
      }
      return { done: total, total };
    },
    [putOne],
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
