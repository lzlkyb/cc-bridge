import { useCallback, useState } from "react";
import type { OverwritePrompt, TransferKind } from "../../lib/transferTypes";

/**
 * 覆盖确认的提问编排：把「弹一个框、等用户选、拿到决定」收敛成一次 `await`。
 *
 * 2026-09-16：从 `useSshTransfer.ts` 抽出。原先上传、下载、批量上传三处各自手写
 * 一遍 `new Promise(resolve => setPrompt({ confirm, skip, cancel }))`，每处 15-20 行且
 * 容易漏掉某条 settle 路径（漏了 `cancel` 就会让调用方的 Promise 永远悬着，
 * 上层的表单再也关不掉——这里踩过）。收成一个 `askOverwrite` 后，三条链路只表达
 * 自己真正关心的东西：问什么、拿到决定后做什么。
 *
 * 它是**编排**而不是 UI：prompt 对象交给调用方渲染（见 `SshTransferBar`），
 * 这里只负责状态与 Promise 的对应关系。
 */

export type OverwriteDecision = "overwrite" | "skip" | "cancel";

export interface AskOverwriteSpec {
  kind: TransferKind;
  /** 展示用：单个文件是完整远程路径，批量时是目标目录。 */
  path: string;
  /** 同名文件清单。调用方负责**去重**：一次拖入 `a/x.txt` 与 `b/x.txt` 时
   *  base name 相同，不去重会让对话框列出重复项并把数量报错。 */
  names: string[];
  /** 批量场景才提供「跳过同名」出口；单个场景给了也没有意义。 */
  skippable?: boolean;
}

export function useTransferPrompt() {
  const [prompt, setPrompt] = useState<OverwritePrompt | null>(null);

  /**
   * 关闭覆盖确认框。必须走 `prompt.cancel()` 而不是直接 `setPrompt(null)`，
   * 否则等待中的 Promise 会永远不结束（上层的表单就永远关不掉）。
   *
   * 不能写成 `setPrompt(p => { p?.cancel(); return null; })`：StrictMode 下
   * updater 会被双调，而 `cancel` 内部又会 `setPrompt`，就嵌套更新了。
   */
  const dismissPrompt = useCallback(() => {
    prompt?.cancel();
  }, [prompt]);

  /** 问一次覆盖。所有 settle 路径都会先关框再 resolve，避免框留在屏幕上。 */
  const askOverwrite = useCallback(
    (spec: AskOverwriteSpec): Promise<OverwriteDecision> =>
      new Promise((resolve) => {
        const settle = (d: OverwriteDecision) => {
          setPrompt(null);
          resolve(d);
        };
        setPrompt({
          kind: spec.kind,
          path: spec.path,
          names: spec.names,
          confirm: () => settle("overwrite"),
          skip: spec.skippable ? () => settle("skip") : undefined,
          cancel: () => settle("cancel"),
        });
      }),
    [],
  );

  return { prompt, dismissPrompt, askOverwrite };
}
