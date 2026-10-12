import { useEffect, useState } from "react";

/**
 * 终端路径点击的「文件回退」：initialPath 往往是**文件**（日志/配置），而文件浏览器
 * 只能列目录——首次列目录失败时回退到父目录再列一次。
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
): void {
  const [fallbackTried, setFallbackTried] = useState(false);
  useEffect(() => {
    if (!error || fallbackTried || !initialPath || path !== initialPath) return;
    setFallbackTried(true);
    // parentRemote 与 SshFileBrowser 内部是同一套规则（剥尾斜杠取父级），这里内联一份
    // 最小实现避免为两行代码反向导出："/" 与 "" 都是根，其余剥掉最后一个 / 的后半段。
    const trimmed = initialPath.replace(/\/$/, "");
    const i = trimmed.lastIndexOf("/");
    setPath(i <= 0 ? "/" : trimmed.slice(0, i));
  }, [error, fallbackTried, initialPath, path, setPath]);
}
