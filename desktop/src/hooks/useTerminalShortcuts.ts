import { useEffect, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { sendTerminalUserInput } from "../lib/terminalUserInput";
import { navJump } from "../lib/terminalCommandNav";
import { isImeComposing } from "../lib/utils";
import { toast } from "../components/ui/toast";

interface Args {
  sessionId: string;
  termRef: MutableRefObject<Terminal | null>;
  /** 终端是否聚焦（ref：window 级监听只挂一次，闭包必须读到最新值）。 */
  focusedRef: MutableRefObject<boolean>;
  closedRef: MutableRefObject<boolean>;
  /** 文本粘贴：返回 true = 剪贴板里有文本且已处理（含「等确认」）；false = 没文本。 */
  pasteRef: MutableRefObject<() => Promise<boolean>>;
  /** 剪贴板图片上传远端；参数是远端 cwd（未知时 null）。 */
  pasteImageRef: MutableRefObject<(cwd: string | null) => void>;
  cwdRef: MutableRefObject<string | null>;
  /** 字号：+1 / -1 / 归位（Ctrl+= / Ctrl+- / Ctrl+0，与 Ctrl+滚轮走同一条 bump）。 */
  fontZoomRef: MutableRefObject<(kind: "in" | "out" | "reset") => void>;
}

/**
 * 终端聚焦时的 window capture 快捷键。
 *
 * 🔴 WHY window capture 而不是 `attachTerminalKeymap`：xterm 的 custom key handler 是
 * **单槽位**，已被 useSshTerminalSession 的复制/粘贴/搜索键位占用；而且这里要处理的是
 * 非按键类动作（图片上传、命令导航）。capture 阶段先于 xterm 的 textarea 处理。
 */
export function useTerminalShortcuts({
  sessionId,
  termRef,
  focusedRef,
  closedRef,
  pasteRef,
  pasteImageRef,
  cwdRef,
  fontZoomRef,
}: Args): void {
  useEffect(() => {
    const send = (data: string) => {
      if (closedRef.current) return;
      void sendTerminalUserInput(sessionId, data).catch(() => toast("输入失败，请检查终端连接", "error"));
    };
    const onKey = (e: KeyboardEvent) => {
      if (!focusedRef.current || isImeComposing(e)) return;
      // 命令导航：Ctrl+Shift+↑/↓ 跳到上一条/下一条命令的提示符行。
      if (e.ctrlKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        const term = termRef.current;
        if (!term) return;
        const dir = e.key === "ArrowUp" ? -1 : 1;
        if (!navJump(term, dir)) {
          toast(dir === -1 ? "没有更早的命令了" : "已经是最新的命令了", "info");
        }
        return;
      }
      // Shift+Enter → LF / Alt+Enter → ESC+CR：多行换行。Claude Code 把 LF 当换行、
      // \r 当提交（shell readline 对 LF 同样 accept-line，与 Ctrl+J 等价，零副作用）。
      // 🔴 必须绕开 useTerminalPaste——preparePaste 会把 \n 规范成 \r，语义就错了。
      if (e.key === "Enter" && !e.ctrlKey) {
        const seq = e.shiftKey && !e.altKey ? "\n" : e.altKey && !e.shiftKey ? "\x1b\r" : null;
        if (seq !== null) {
          e.preventDefault();
          e.stopPropagation();
          send(seq);
          return;
        }
      }
      // Ctrl+= / Ctrl+- / Ctrl+0 → 字号放大 / 缩小 / 归位。以前只有 Ctrl+滚轮：笔记本
      // 触控板或不想动鼠标时没有入口，而 VS Code / 浏览器的惯例就是这个组合。
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const zoom =
          e.key === "=" || e.key === "+" || e.key === "Add"
            ? "in"
            : e.key === "-" || e.key === "_" || e.key === "Subtract"
              ? "out"
              : e.key === "0"
                ? "reset"
                : null;
        if (zoom) {
          e.preventDefault();
          e.stopPropagation();
          fontZoomRef.current(zoom);
          return;
        }
      }
      // Ctrl+Shift+V：**先当文本粘贴**（Linux/Windows 通行约定），剪贴板里没有文本才
      // 退化成「上传图片」。以前这里无条件走图片，结果：从网页复制一段文字按
      // Ctrl+Shift+V，得到一个「剪贴板里没有图片」的红 toast，一个字都粘不进去。
      if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
        e.preventDefault();
        e.stopPropagation();
        void (async () => {
          const handled = await pasteRef.current();
          if (!handled) pasteImageRef.current(cwdRef.current);
        })();
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sessionId, termRef, focusedRef, closedRef, pasteRef, pasteImageRef, cwdRef, fontZoomRef]);
}
