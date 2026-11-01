import { useCallback, useRef, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
// 用 Tauri 插件读剪贴板，而不是 navigator.clipboard.readText()：后者在 WebView2 里
// 需要 clipboard-read 权限（无提示 UI，往往静默被拒）。插件路径确定，
// 但需在 capabilities 里显式给 `clipboard-manager:allow-read-text`——
// `clipboard-manager:default` 自述就是“No features are enabled by default”，它什么都不授予。
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { sendTerminalUserInput } from "../../lib/terminalUserInput";
import { toast } from "../ui/toast";
import { preparePaste, shouldConfirmPaste } from "../../lib/terminalPaste";

/** 两段式确认的窗口：第一次 Ctrl+V 之后多久内再按才算确认。 */
export const PASTE_CONFIRM_WINDOW_MS = 10_000;

interface Args {
  sessionId: string;
  /** 会话已断开：粘贴直接报错而不是静默失败。 */
  closedRef: MutableRefObject<boolean>;
  termRef: RefObject<Terminal | null>;
}

/**
 * 终端粘贴：读剪贴板 → 规范化 + 按远端模式包裹 → 发给远端。
 *
 * **多行内容走两段式确认**（不是模态弹窗）：远端没开 bracketed paste 且内容含
 * 换行时，第一次 Ctrl+V 只弹 toast 提示，窗口期内再按一次 Ctrl+V 才真正发送。
 * 判据见 `shouldConfirmPaste`——bracketed paste 开着的程序（bash/zsh/Claude Code）
 * 整块插入不执行，永远不打断；模态框在终端场景太重（打键盘流），两段式是
 * 「多按一次键」级别的确认，可发现性由 toast 文案负责。
 *
 * 单独成 hook 是为了把这块逻辑从 `useSshTerminalSession` 里拿出来：那个 hook 的
 * 状态/effect 数量已经顶到规则 7 的上限，而粘贴与终端的生命周期、尺寸同步没有耦合。
 */
export function useTerminalPaste({ sessionId, closedRef, termRef }: Args) {
  /** 上一次被拦下的粘贴：{ 到期时间, 规范化前的原始文本 }。窗口外/已确认即清空。 */
  const pendingRef = useRef<{ expiresAt: number; text: string } | null>(null);

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
        await sendTerminalUserInput(sessionId, data);
      } catch (e) {
        toast(`粘贴失败：${e}`, "error");
      }
    },
    [sessionId, closedRef, termRef],
  );

  /**
   * 粘贴入口（快捷键 / 工具栏 / 右键菜单共用）。
   *
   * 返回 true = 剪贴板里有文本且已处理（含「已拦住等确认」）；false = 没有文本，
   * 调用方（Ctrl+Shift+V）据此决定要不要退化成图片上传。
   *
   * 空剪贴板**静默返回**：右键误触不应该弹提示。读取失败则必须报，不吞。
   * `notifyEmpty` 给键盘路径用（Ctrl+V 是按下去的明确意图，静默会让人以为快捷键坏了）。
   * 粘完把焦点还给终端（按钮/右键路径不依赖焦点，但粘完得能接着敲）。
   */
  const paste = useCallback(
    async (opts?: { notifyEmpty?: boolean }): Promise<boolean> => {
      let text: string;
      try {
        text = (await readText()) ?? "";
      } catch (e) {
        toast(`读取剪贴板失败：${e}`, "error");
        return false;
      }
      if (!text) {
        if (opts?.notifyEmpty) toast("剪贴板里没有文本；图片请按 Ctrl+Shift+V", "info");
        return false;
      }
      const pending = pendingRef.current;
      pendingRef.current = null;
      // 两段式：上次被拦的粘贴还在窗口内 **且剪贴板内容没变** → 这次就是确认。
      // 必须比对内容：拦下之后用户又复制了别的东西，照旧内容执行是危险的（他以为在执行新的）。
      if (pending && Date.now() <= pending.expiresAt && pending.text === text) {
        await sendPaste(text);
        termRef.current?.focus();
        return true;
      }
      const bracketed = termRef.current?.modes.bracketedPasteMode === true;
      if (shouldConfirmPaste(text, bracketed)) {
        pendingRef.current = { expiresAt: Date.now() + PASTE_CONFIRM_WINDOW_MS, text };
        // 🔴 必须把焦点还给终端：从工具栏 / 右键菜单触发时焦点还在按钮上，而确认按键走的是
        // xterm 的 custom key handler（只在终端聚焦时触发）⇒ 不给焦点这 10 秒就是死路。
        termRef.current?.focus();
        toast("内容含多行且远端未开启安全粘贴模式，10 秒内再按一次 Ctrl+V 确认执行", "info");
        return true;
      }
      await sendPaste(text);
      termRef.current?.focus();
      return true;
    },
    [sendPaste, termRef],
  );

  // 键盘路径专用入口：Ctrl+V 是按下去的明确意图，空剪贴板也要说一句，否则看着像快捷键坏了。
  const pasteFromKey = useCallback(() => void paste({ notifyEmpty: true }), [paste]);

  return { paste, pasteFromKey };
}
