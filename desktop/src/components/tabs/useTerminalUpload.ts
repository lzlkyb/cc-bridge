import { useCallback, useState } from "react";
import { useSshTransfer } from "./useSshTransfer";
import { loadUploadDir, saveUploadDir, normalizeRemoteDir } from "../../lib/uploadDir";
import { pickUploadableFiles, type LocalFile } from "../../lib/localFiles";
import type { SshConnection } from "../../lib/types";

export type { LocalFile };

/**
 * 终端拖拽上传的编排：分辨文件夹 → 确认目录 → 批量上传 → 给出远端路径。
 *
 * 单独成 hook 而不是写进 `TerminalTab`：后者已经 246 行，靠近 300 行上限（规则 7）。
 */
export function useTerminalUpload(conn: SshConnection | null) {
  const tx = useSshTransfer();
  const [pending, setPending] = useState<LocalFile[] | null>(null);
  const [dir, setDir] = useState("/");
  const [result, setResult] = useState<{ dir: string; count: number } | null>(null);

  /**
   * 正在忙（拖入遮罩靠它屏蔽）。
   *
   * 🔴 必须包含 `tx.prompt`（覆盖确认框开着）。漏了的后果：确认框开着时还能
   * 接第二批拖放，第二次 `setPrompt` 覆盖掉第一次，第一批的 Promise
   * **永远不会 resolve**（uploadMany 的循环卡死、列表不再刷新），
   * 而且两个循环共用同一个 `idRef`，取消与进度会打到错误的传输上。
   */
  const busy = tx.transfer !== null || pending !== null || tx.prompt !== null;

  const dropped = useCallback(
    async (paths: string[]) => {
      if (!conn) return;
      // 文件夹 / 不存在的路径在这里面就被拒掉并提示了（与文件面板入口共用）。
      const files = await pickUploadableFiles(paths);
      if (!files.length) return;
      setDir(loadUploadDir(conn.id));
      setPending(files);
    },
    [conn],
  );

  const cancelSheet = useCallback(() => setPending(null), []);

  const confirm = useCallback(
    async (target: string) => {
      if (!conn || !pending) return;
      const files = pending;
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
        setResult({ dir: normalizeRemoteDir(target), count: r.done });
      }
    },
    [conn, pending, tx],
  );

  return {
    ...tx,
    busy,
    pending,
    dir,
    result,
    dropped,
    cancelSheet,
    confirm,
    dismissResult: useCallback(() => setResult(null), []),
  };
}
