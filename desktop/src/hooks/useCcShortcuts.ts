import { useEffect } from "react";
import { isEditableTarget } from "../lib/utils";

/** CC 对话页的窗口级快捷键入参。 */
export type CcShortcutHandlers = {
  /** 开一条新会话（新起一条，不动当前这条）。 */
  onNewSession: () => void;
  /** 切到上一条 / 下一条会话。`+1` = 往后（Ctrl+Tab）。 */
  onCycleSession?: (delta: 1 | -1) => void;
  /** 收起 / 展开会话侧栏。 */
  onToggleSidebar?: () => void;
};

/**
 * CC 对话页的窗口级快捷键：**Ctrl/⌘+N 新会话、Ctrl+Tab 切会话、
 * Ctrl+Shift+Tab 反向切、Ctrl/⌘+Shift+B 收起侧栏**。
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
 * 切标签」不是它的特性。所以本页这两个键本来就能被前端监听到，无需
 * prevent-default 插件（那个插件还要 Tauri ≥ 2.12），也不用动 Rust。
 *
 * ## 为什么用 `e.code` 而不是 `e.key`
 *
 * 非拉丁键盘布局下 Ctrl 组合键的 `e.key` 不一定是 "n"，而 `e.code` 是物理键位，
 * 与布局无关。`e.key` 只作兜底（个别虚拟键盘/IME 下 code 为空）。
 *
 * ## 为什么「切会话」不看焦点、而「新会话」看
 *
 * Ctrl+Tab 的语义就是「离开当前这块去别处」，正打着字时切会话是最常见的情形 ——
 * 拦掉它等于让快捷键在最需要的时刻失效。Ctrl+N 相反：手正在输入框里时按下去，
 * 多半是想在草稿里换行/补全时误触，而新建会话会把视线从当前对话上挪走。
 *
 * ## 故意不收的两种按法
 *
 * - **`Ctrl+Shift+N`**：浏览器惯例里它是「无痕窗口」，本应用没有对应概念，
 *   先不收，免得将来想用时已被人占用。
 * - **`Ctrl+Alt+N`**：部分欧洲布局下 AltGr 就是 Ctrl+Alt，那是**字符输入键**，
 *   收了会把用户打不出来的字符变得更打不出来。
 * - 长按（`e.repeat`）只触发一次：连开十条空会话没有意义，还会把消息流冲掉。
 */
export function useCcShortcuts({
  onNewSession,
  onCycleSession,
  onToggleSidebar,
}: CcShortcutHandlers) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey || e.repeat) return;

      // Ctrl+Tab / Ctrl+Shift+Tab：切会话（Shift 反向）。
      if (e.code === "Tab" || e.key === "Tab") {
        if (!onCycleSession) return;
        e.preventDefault();
        onCycleSession(e.shiftKey ? -1 : 1);
        return;
      }

      // Ctrl/⌘+Shift+B：收起 / 展开侧栏（与终端侧栏同一组键位）。
      if ((e.code === "KeyB" || e.key.toLowerCase() === "b") && e.shiftKey) {
        if (!onToggleSidebar) return;
        e.preventDefault();
        onToggleSidebar();
        return;
      }

      if (e.code !== "KeyN" && e.key.toLowerCase() !== "n") return;
      if (e.shiftKey) return;
      // 焦点在输入区一律让路：输密码、敲命令参数时被快捷键劫持是最烦人的一类 bug。
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      onNewSession();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNewSession, onCycleSession, onToggleSidebar]);
}
