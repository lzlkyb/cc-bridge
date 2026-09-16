import { useCallback, useState } from "react";
import { useSshTransfer } from "./useSshTransfer";
import { loadUploadDir, saveUploadDir, normalizeRemoteDir } from "../../lib/uploadDir";
import { pickUploadableFiles, type LocalFile } from "../../lib/localFiles";
import type { SshConnection } from "../../lib/types";

export type { LocalFile };

/** 上传结果条的数据。留一份 `files` 供「改目录」重传。 */
interface UploadResult {
  dir: string;
  count: number;
  /** 刚传完的那批文件（相对本地路径），传错目录时用来重传。 */
  files: LocalFile[];
}

/**
 * 终端拖拽上传的编排：定目标目录 → 批量上传 → 给出远端路径。
 *
 * 目标目录优先用 `cwd`——**远端 shell 的当前目录**，由 OSC 7 探到（见
 * `hooks/useTerminalOsc.ts`）。那就是用户此刻所在的目录，完全符合直觉，所以**不问**。
 * 只有探不到 cwd 时才退回「上次用过的目录 + 问一句」（注入被关、远端非 bash/zsh、
 * 或还没收到回执）。文件面板的拖入上传早就是这个设计（见 `useFileBrowserDrop.ts`），
 * 这里只是把终端侧补齐。
 *
 * 单独成 hook 而不是写进 `TerminalTab`：后者已经 246 行，靠近 300 行上限（规则 7）。
 */
export function useTerminalUpload(conn: SshConnection | null, cwd: string | null) {
  const tx = useSshTransfer();
  const [pending, setPending] = useState<LocalFile[] | null>(null);
  const [dir, setDir] = useState("/");
  const [result, setResult] = useState<UploadResult | null>(null);

  /**
   * 正在忙（拖入遮罩靠它屏蔽）。
   *
   * 🔴 必须包含 `tx.prompt`（覆盖确认框开着）。漏了的后果：确认框开着时还能
   * 接第二批拖放，第二次 `setPrompt` 覆盖掉第一次，第一批的 Promise
   * **永远不会 resolve**（uploadMany 的循环卡死、列表不再刷新），
   * 而且两个循环共用同一个 `idRef`，取消与进度会打到错误的传输上。
   */
  const busy = tx.transfer !== null || pending !== null || tx.prompt !== null;

  /** 真正开传：记住目录 → 批量上传 → 成功则挂结果条。 */
  const start = useCallback(
    async (target: string, files: LocalFile[]) => {
      if (!conn) return;
      setPending(null);
      setResult(null);
      saveUploadDir(conn.id, target);
      // `existing` 不传 → uploadMany 会先列一次目标目录做同名检查。
      // 终端拖拽手里没有目录列表，不补这一步就是静默覆盖。
      const r = await tx.uploadMany({
        connectionId: conn.id,
        dir: target,
        files: files.map((f) => ({ local: f.path, name: f.name })),
      });
      if (r.done > 0) {
        setResult({ dir: normalizeRemoteDir(target), count: r.done, files });
      }
    },
    [conn, tx],
  );

  const dropped = useCallback(
    async (paths: string[]) => {
      if (!conn) return;
      // 文件夹 / 不存在的路径在这里面就被拒掉并提示了（与文件面板入口共用）。
      const files = await pickUploadableFiles(paths);
      if (!files.length) return;
      // 探到了 cwd：直接传到用户当前所在的目录，不打断。
      if (cwd) {
        await start(cwd, files);
        return;
      }
      // 探不到：确实不知道传到哪，才问（预填上次用过的目录）。
      setDir(loadUploadDir(conn.id));
      setPending(files);
    },
    [conn, cwd, start],
  );

  const cancelSheet = useCallback(() => setPending(null), []);

  const confirm = useCallback(
    (target: string) => {
      if (!pending) return;
      void start(target, pending);
    },
    [pending, start],
  );

  /**
   * 结果条上的「改目录」：把刚传完的那批放回待确认队列，重传一次。
   *
   * 这是免掉「每次拖拽都问一遍」的补偿出口——传错可重传，比每次都拦一下划算。
   */
  const changeDir = useCallback(() => {
    if (!result) return;
    setDir(result.dir);
    setPending(result.files);
    setResult(null);
  }, [result]);

  return {
    ...tx,
    busy,
    pending,
    dir,
    result,
    dropped,
    cancelSheet,
    confirm,
    changeDir,
    dismissResult: useCallback(() => setResult(null), []),
  };
}
