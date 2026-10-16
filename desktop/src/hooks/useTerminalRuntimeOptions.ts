import { useEffect, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { terminalThemeOptions, type TerminalPreset } from "../lib/terminalTheme";
import { subscribeScrollback } from "../lib/terminalScrollback";
import type { Theme } from "../lib/theme";

/**
 * 需要**热切换**的 xterm 运行时选项——只改 options，不重建终端（重建会丢
 * 历史输出与连接，见 useSshTerminalSession 创建 effect 的头注）：
 * - 主题/预设：颜色不影响 rows/cols，无需 fit；
 * - 回滚缓冲行数：订阅全局设置广播，调小时 xterm 自动从最旧一侧裁剪。
 *
 * WHY 单独成 hook：useSshTerminalSession 的 hook 数已顶到体量门禁上限，
 * 这两个 effect 只依赖 termRef + 观感参数，与会话生命周期/输入输出回路零耦合。
 */
export function useTerminalRuntimeOptions(
  termRef: MutableRefObject<Terminal | null>,
  mode: Theme,
  preset: TerminalPreset,
): void {
  // 主题/预设热切换。
  useEffect(() => {
    const term = termRef.current;
    if (term) Object.assign(term.options, terminalThemeOptions(mode, preset));
  }, [mode, preset, termRef]);

  // 回滚缓冲热切换：设置页改值后所有开着的终端同步。
  useEffect(
    () =>
      subscribeScrollback((n) => {
        if (termRef.current) termRef.current.options.scrollback = n;
      }),
    [termRef],
  );
}
