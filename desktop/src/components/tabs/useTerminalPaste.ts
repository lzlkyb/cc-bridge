import { useCallback, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
// 用 Tauri 插件读剪贴板，而不是 navigator.clipboard.readText()：后者在 WebView2 里
// 需要 clipboard-read 权限（无提示 UI，往往静默被拒）。插件路径确定，
// 但需在 capabilities 里显式给 `clipboard-manager:allow-read-text`——
// `clipboard-manager:default` 自述就是“No features are enabled by default”，它什么都不授予。
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { preparePaste } from "../../lib/terminalPaste";

interface Args {
  sessionId: string;
  /** 会话已断开：粘贴直接报错而不是静默失败。 */
  closedRef: MutableRefObject<boolean>;
  termRef: RefObject<Terminal | null>;
}

/**
 * 终端粘贴：读剪贴板 → 规范化 + 按远端模式包裹 → 发给远端。
 *
 * **不弹确认框**。判据从「本地数几行」换成「远端支不支持 bracketed paste」：
 * bash/zsh 的 readline 默认开着它，内容会整块插进编辑缓冲区、显示成多行、
 * 等用户按回车——与「粘贴就是插入」的预期一致，没有打断的必要。
 *
 * 单独成 hook 是为了把这块逻辑从 `useSshTerminalSession` 里拿出来：那个 hook 的
 * 状态/effect 数量已经顶到规则 7 的上限，而粘贴与终端的生命周期、尺寸同步没有耦合。
 */
export function useTerminalPaste({ sessionId, closedRef, termRef }: Args) {
  /** 把文本规范化 + 包裹后发给远端 PTY。 */
  const sendPaste = useCallback(
    async (text: string) => {
      if (closedRef.current) {
        toast("连接已断开，无法输入", "error");
        return;
      }
      // 每次都读远端当前模式，不缓存：同一会话里 vi / less / cat 各会开关各的。
      const data = preparePaste(text, termRef.current?.modes.bracketedPasteMode === true);
      try {
        await invoke("ssh_input", { sessionId, data });
      } catch (e) {
        toast(`粘贴失败：${e}`, "error");
      }
    },
    [sessionId, closedRef, termRef],
  );

  /**
   * 粘贴入口（快捷键 / 工具栏 / 右键菜单共用）。
   *
   * 空剪贴板**静默返回**：右键误触不应该弹提示。读取失败则必须报，不吞。
   * 粘完把焦点还给终端（按钮/右键路径不依赖焦点，但粘完得能接着敲）。
   */
  const paste = useCallback(async () => {
    let text: string;
    try {
      text = (await readText()) ?? "";
    } catch (e) {
      toast(`读取剪贴板失败：${e}`, "error");
      return;
    }
    if (!text) return;
    await sendPaste(text);
    termRef.current?.focus();
  }, [sendPaste, termRef]);

  return { paste };
}
