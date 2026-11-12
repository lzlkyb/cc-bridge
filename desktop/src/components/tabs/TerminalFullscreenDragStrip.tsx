import { useTitlebarDrag } from "../../hooks/useTitlebarDrag";

/**
 * 终端全屏时顶部的窗口拖拽条（H8，2026-11-10）。
 *
 * 抽成独立组件而不是内联在 `TerminalTabsBar` 里：那个文件已贴着 300 行体量上限，
 * 而这里需要多调一个 hook。行为与顶栏、侧栏品牌区一致——从别的软件点进来那一下
 * 只激活窗口，不把窗口拖走。
 */
export function TerminalFullscreenDragStrip() {
  const onMouseDown = useTitlebarDrag();
  return (
    <div
      className="terminal-fullscreen-drag"
      data-tauri-drag-region="false"
      onMouseDown={onMouseDown}
      title="拖动窗口"
    />
  );
}
