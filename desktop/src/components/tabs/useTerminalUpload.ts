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
 * 🔴 松手**不直接传**，一律过一次确认框（2026-11-26 交互审计 P1）。此前探到 cwd 就静默开传，
 * 而「拖向文件面板 / 别的窗口却松手在终端上」是常见误操作：文件已经写到服务器上了，
 * 撤回不了（同名覆盖有确认，新文件没有）。确认框预填 cwd（OSC 7 探到的远端当前目录，
 * 见 hooks/useTerminalOsc.ts），回车即传，代价是一次按键；探不到 cwd 时退回上次用过的目录。
 * 文件面板那侧的拖放仍是直传——它的目标目录就写在路径条上，不存在「传到哪」的歧义。
 *
 * 单独成 hook 而不是写进 `TerminalTab`：后者已经 246 行，靠近 300 行上限（规则 7）。
 */
export function useTerminalUpload(conn: SshConnection | null, cwd: string | null) {
  const tx = useSshTransfer();
  const [pending, setPending] = useState<LocalFile[] | null>(null);
  const [dir, setDir] = useState("/");
  /** 确认框里的目录是不是探到的 cwd（决定说明文案：预填当前目录 vs 上次用过的目录）。 */
  const [dirFromCwd, setDirFromCwd] = useState(false);
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
      // 一律进确认框：预填探到的 cwd，探不到才退回上次用过的目录（理由见头注）。
      // 归一化再预填：cwd 来自远端回执，带尾斜杠时会被目录校验判非法，确认框就卡住了。
      setDirFromCwd(Boolean(cwd));
      setDir(normalizeRemoteDir(cwd ?? loadUploadDir(conn.id)));
      setPending(files);
    },
    [conn, cwd],
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
   * 传错目录不用重新拖一遍文件。
   */
  const changeDir = useCallback(() => {
    if (!result) return;
    setDirFromCwd(false);
    setDir(result.dir);
    setPending(result.files);
    setResult(null);
  }, [result]);

  return {
    ...tx,
    busy,
    pending,
    dir,
    dirFromCwd,
    result,
    dropped,
    cancelSheet,
    confirm,
    changeDir,
    dismissResult: useCallback(() => setResult(null), []),
  };
}
