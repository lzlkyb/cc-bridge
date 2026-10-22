import { useEffect, useState } from "react";
import type { SshFileEntry } from "../lib/types";
import { isInitialFileListing, remoteFileName, remoteParentPath } from "../lib/sshFilePaths";

/**
 * 终端路径点击的「文件回退」：initialPath 往往是**文件**（日志/配置），而文件浏览器
 * 只能列目录——识别 ls(file) 成功结果或首次失败，回退父目录并定位文件。
 *
 * WHY 独立 hook：`SshFileBrowser` 的 useState/useEffect 数在体量棘轮基线上（12），
 * 一行都不能加；这个回退又只有「一个布尔 + 一个 effect」，搬出去零成本。
 * 只兜 initialPath 一层：正常导航中用户自己输错的路径照常报错，不受影响。
 */
export function useSshFileInitialPath(
  initialPath: string | undefined,
  error: string | null,
  path: string,
  setPath: (p: string) => void,
  entries: SshFileEntry[],
): string | undefined {
  const [fallbackTried, setFallbackTried] = useState(false);
  useEffect(() => {
    if (fallbackTried || !initialPath || path !== initialPath || (!error && !isInitialFileListing(initialPath, entries))) return;
    setFallbackTried(true);
    // ls(file) succeeds too; reveal the file in its parent instead of treating it as a directory.
    setPath(remoteParentPath(initialPath));
  }, [error, fallbackTried, initialPath, path, setPath, entries]);
  return fallbackTried && initialPath && path === remoteParentPath(initialPath) ? remoteFileName(initialPath) : undefined;
}
