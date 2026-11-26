/**
 * 焦点是否落在**应用自己的**输入控件里（重命名框 / 查找条 / 搜索浮层 / 弹窗输入）。
 *
 * 全局快捷键（Ctrl+Tab、Ctrl+Shift+G/B/D、F11）共用这一条判据：正在打字时不抢键。
 * 对标 VS Code 的 `when` 子句——同一个键在 `inputFocus` 与 `editorTextFocus` 下归属不同。
 *
 * 🔴 必须排除 `.xterm` 内部：终端的隐藏 textarea 也是 TEXTAREA，但那是「在终端里打字」，
 * 恰恰是这些快捷键要服务的场景。把它算成打字，等于终端聚焦时所有标签级快捷键全失效。
 */
export function isTypingInUi(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el.closest(".xterm")) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}