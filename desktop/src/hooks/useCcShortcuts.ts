import { useEffect } from "react";
import { isEditableTarget } from "../lib/utils";

/** CC 对话页的窗口级快捷键入参。 */
export type CcShortcutHandlers = {
  /** 开一条新会话（清空当前会话链）。 */
  onNewSession: () => void;
};

/**
 * CC 对话页的窗口级快捷键。目前只有一条：**Ctrl+N / ⌘N 新对话**。
 *
 * ## 为什么挂在 window 而不是某个元素上
 *
 * 对话页的焦点会在「输入框 / 对话流 / 历史面板」之间来回跳，挂元素上就得在每个
 * 可聚焦处各接一次，漏一处就是「有时候灵有时候不灵」。挂 window 一次到位，
 * 再用 `isEditableTarget` 把输入区让出来。
 *
 * ## 为什么不用引 `tauri-plugin-prevent-default`
 *
 * WebView2 只自持一批加速键（Ctrl+F/F3、Ctrl+P、Ctrl+R/F5、Ctrl+±、Ctrl+Shift+C、
 * F12、Back/Forward/Search，见微软 `AreBrowserAcceleratorKeysEnabled` 文档），
 * **Ctrl+N 与 Ctrl+Tab 都不在名单里**——WebView2 没有浏览器 chrome，「新窗口 /
 * 切标签」不是它的特性。所以本页的 Ctrl+N 本来就能被前端监听到，无需
 * prevent-default 插件（那个插件还要 Tauri ≥ 2.12），也不用动 Rust。
 *
 * ## 为什么用 `e.code` 而不是 `e.key`
 *
 * 非拉丁键盘布局下 Ctrl 组合键的 `e.key` 不一定是 "n"，而 `e.code` 是物理键位，
 * 与布局无关。`e.key` 只作兜底（个别虚拟键盘/IME 下 code 为空）。
 *
 * ## 故意不收的两种按法
 *
 * - **`Ctrl+Shift+N`**：浏览器惯例里它是「无痕窗口」，本应用没有对应概念，
 *   先不收，免得将来想用时已被人占用。
 * - **`Ctrl+Alt+N`**：部分欧洲布局下 AltGr 就是 Ctrl+Alt，那是**字符输入键**，
 *   收了会把用户打不出来的字符变得更打不出来。
 * - 长按（`e.repeat`）只触发一次：连开十条空会话没有意义，还会把消息流冲掉。
 *
 * ## 为什么没有 Ctrl+Tab 切会话
 *
 * 那需要「多条会话并存」的 UI（批 3 的多会话形态）。现在只有一条会话链，
 * 没有可切的对象，先不占键位。
 */
export function useCcShortcuts({ onNewSession }: CcShortcutHandlers) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "KeyN" && e.key.toLowerCase() !== "n") return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.altKey || e.shiftKey) return;
      if (e.repeat) return;
      // 焦点在输入区一律让路：输密码、敲命令参数时被快捷键劫持是最烦人的一类 bug。
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      onNewSession();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNewSession]);
}
