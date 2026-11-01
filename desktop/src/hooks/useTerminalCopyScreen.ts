import { useCallback, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { screenToText } from "../lib/terminalScreen";
import { trimCopyText } from "../lib/terminalPaste";
import { toast } from "../components/ui/toast";

/**
 * 整屏快照复制：从 xterm 缓冲区导出可视区域纯文本，不依赖选区
 * （远端 TUI 开着鼠标报告、选区随时被重绘冲掉时也必成）。
 *
 * WHY 单独成 hook：它只依赖终端实例，与连接/输入/尺寸回路零耦合；
 * 而 `useSshTerminalSession` 已经顶到体量棘轮线，塞不下新逻辑。
 */
export function useTerminalCopyScreen(termRef: RefObject<Terminal | null>): () => void {
  return useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const text = screenToText(term.buffer, term.rows);
    if (!text.trim()) {
      toast("终端为空", "error");
      return;
    }
    navigator.clipboard
      // 与「复制选中」同走 trimCopyText：两条复制路径行为必须一致，
      // 整屏快照按 cell 网格取字，行尾空白只会更多不会更少。
      .writeText(trimCopyText(text))
      .then(() => toast("已复制整屏", "success"))
      .catch(() => toast("复制失败", "error"));
  }, [termRef]);
}
