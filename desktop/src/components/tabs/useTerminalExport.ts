import { useCallback, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { toast } from "../ui/toast";
import { bufferToText, downloadText, exportFileName } from "../../lib/terminalExport";

/**
 * 导出当前会话的整个滚动历史为 .txt。
 *
 * 读的是**本地缓冲区**，所以断开态也能导出——而「连不上了，把输出捞出来」恰恰是
 * 最需要导出的场景。文本为空时给提示而不是导出一个空文件（否则用户以为坏了）。
 *
 * 单独成 hook 的直接原因是体量门禁：`SshTerminal.tsx` 紧贴 300 行棘轮线，
 * 这段逻辑自带说明注释，塞回去就破线。
 */
export function useTerminalExport(
  termRef: MutableRefObject<Terminal | null>,
  name: string,
): () => void {
  return useCallback(() => {
    const term = termRef.current;
    const text = term ? bufferToText(term.buffer.active) : "";
    if (!text.trim()) {
      toast("终端没有可导出的内容", "info");
      return;
    }
    downloadText(exportFileName(name), text);
    toast(`已导出 ${text.split("\n").length} 行`, "success");
  }, [termRef, name]);
}
