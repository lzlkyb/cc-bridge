import { useEffect, useRef, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { sendTerminalUserInput } from "../lib/terminalUserInput";
import { clearTerminalInput } from "../lib/terminalClearInput";
import { navJump } from "../lib/terminalCommandNav";
import { decideCtrlC } from "../lib/terminalCtrlC";
import { trimCopyText } from "../lib/terminalPaste";
import { copyText, isImeComposing } from "../lib/utils";
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
  // 复制后选区会消失，但同一次按住触发的重复按键仍不能成为远端中断。
  const copiedInHoldRef = useRef(false);

  useEffect(() => {
    const send = (data: string) => {
      if (closedRef.current) return;
      void sendTerminalUserInput(sessionId, data).catch(() => toast("输入失败，请检查终端连接", "error"));
    };
    const onKey = (e: KeyboardEvent) => {
      if (!focusedRef.current) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const composing = isImeComposing(e);
      const copyKey = ctrl && !e.shiftKey && !e.altKey
        && (e.key === "c" || e.key === "C" || composing && e.code === "KeyC");
      if (composing && !copyKey) return;
      // Ctrl+C：**有 live 选区 = 复制**（复制完清选区），没选区才放行成 SIGINT。
      // 为什么必须在这里拦：`terminalKeymap` 只抢带 shift 的组合，不带 shift 的 Ctrl+C
      // 原样放行给 xterm ⇒ 发 \x03。而在 TUI（Claude Code）里选定文字后按 Ctrl+C 想
      // 复制的人，收到的就是「任务被打断」。语义裁决见 lib/terminalCtrlC.ts。
      if (copyKey) {
        // 新的一次按下（非自动重复）⇒ 本次按住的「已复制」标记重新开始。
        if (!e.repeat) copiedInHoldRef.current = false;
        // 🔴 只认 live 选区，不兜 10 秒缓存：否则「十分钟前选过、现在想中断」会被
        // 静默改成复制，用户按几次都停不下来。
        const terminal = termRef.current;
        const selection = terminal?.getSelection() ?? "";
        const action = decideCtrlC({
          hasSelection: !!terminal?.hasSelection(),
          composing,
          repeat: e.repeat,
          copiedInHold: copiedInHoldRef.current,
        });
        if (action === "interrupt") return; // 放行给 xterm → 发 \x03
        // 组合输入由输入法处理，拦住 xterm 时保留系统默认动作。
        if (!composing) e.preventDefault();
        e.stopPropagation();
        if (action === "swallow") return; // 复制后的按住不放：一个字节都不发
        copiedInHoldRef.current = true;
        const text = trimCopyText(selection);
        if (!text.trim()) {
          toast("选区中没有可复制的文字", "info");
          return;
        }
        void copyText(text, () => {
          if (terminal && termRef.current === terminal && terminal.getSelection() === selection) terminal.clearSelection();
          toast(`已复制 ${text.length} 字`, "success");
        },
          () => toast("复制失败", "error"),
        );
        return;
      }
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
      // Ctrl+Shift+U：清空已经敲进去的输入。终端里没有"输入框"，只能按屏幕反推该发
      // 多少个 Backspace（见 lib/terminalClearInput.ts）。远端的 Ctrl+U 是 readline 的
      // kill-line，只删光标所在行；这个组合键连多行粘贴一起清。
      if (e.ctrlKey && e.shiftKey && (e.key === "u" || e.key === "U")) {
        e.preventDefault();
        e.stopPropagation();
        const term = termRef.current;
        if (!term) return;
        const r = clearTerminalInput(term, send);
        if (r.blocked) toast("当前是选择状态或连接已断开，先点一下终端", "info");
        else if (r.count === 0) toast("没有可清空的输入", "info");
        return;
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
    // 松手复位：下一次按 Ctrl+C 才是「新的一次」。
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "c" || e.key === "C") copiedInHoldRef.current = false;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [sessionId, termRef, focusedRef, closedRef, pasteRef, pasteImageRef, cwdRef, fontZoomRef]);
}
