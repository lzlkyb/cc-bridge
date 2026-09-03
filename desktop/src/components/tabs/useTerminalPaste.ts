import { useCallback, useState, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
// 用 Tauri 插件读剪贴板，而不是 navigator.clipboard.readText()：后者在 WebView2 里
// 需要 clipboard-read 权限（无提示 UI，往往静默被拒）。插件路径确定，
// 但需在 capabilities 里显式给 `clipboard-manager:allow-read-text`——
// `clipboard-manager:default` 自述就是“No features are enabled by default”，它什么都不授予。
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { countPasteLines, pastePreview } from "../../lib/terminalPaste";

/** 多行粘贴确认框的数据；null = 不弹。 */
export interface PastePrompt {
  lineCount: number;
  preview: string;
  confirm: () => void;
  cancel: () => void;
}

interface Args {
  sessionId: string;
  /** 会话已断开：粘贴直接报错而不是静默失败。 */
  closedRef: MutableRefObject<boolean>;
  termRef: RefObject<Terminal | null>;
}

/**
 * 终端粘贴：读剪贴板 → 多行先问一句 → 发给远端。
 *
 * 单独成 hook 是为了把「确认框」这个 state 从 `useSshTerminalSession` 里拿出来：
 * 那个 hook 的状态/effect 数量已经顶到规则 7 的上限，而粘贴与终端的生命周期、
 * 尺寸同步那些事没有逻辑耦合。
 */
export function useTerminalPaste({ sessionId, closedRef, termRef }: Args) {
  const [pastePrompt, setPastePrompt] = useState<PastePrompt | null>(null);

  /** 把文本原样发给远端 PTY。 */
  const sendPaste = useCallback(
    async (text: string) => {
      if (closedRef.current) {
        toast("连接已断开，无法输入", "error");
        return;
      }
      try {
        await invoke("ssh_input", { sessionId, data: text });
      } catch (e) {
        toast(`粘贴失败：${e}`, "error");
      }
    },
    [sessionId, closedRef],
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
    const refocus = () => termRef.current?.focus();
    if (countPasteLines(text) > 1) {
      setPastePrompt({
        lineCount: countPasteLines(text),
        preview: pastePreview(text),
        confirm: () => {
          setPastePrompt(null);
          void sendPaste(text).then(refocus);
        },
        cancel: () => {
          setPastePrompt(null);
          refocus();
        },
      });
      return;
    }
    await sendPaste(text);
    refocus();
  }, [sendPaste, termRef]);

  return { paste, pastePrompt };
}
