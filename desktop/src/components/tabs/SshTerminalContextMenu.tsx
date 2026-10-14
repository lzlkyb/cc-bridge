import { useEffect, useState, type RefObject } from "react";
import { SshTerminalMenu, type TerminalMenuPos } from "./SshTerminalMenu";

interface Props {
  /** 终端容器（右键监听的挂载点）。 */
  containerRef: RefObject<HTMLDivElement>;
  /** 有无选中内容——菜单弹起那一刻才求值：用户可能刚拖选完就右键。 */
  hasSelection: () => boolean;
  /** 会话已断开时置灰「粘贴」。 */
  pasteDisabled: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}

/**
 * 终端右键菜单层：接管容器的 contextmenu、用自己的菜单替换浏览器默认菜单。
 *
 * WHY 单独一个组件（从 `SshTerminal.tsx` 抽出）：那个文件只有 1 行余量就顶到
 * 300 行棘轮线，而这块是自包含的（一个 state + 一个监听 + 一处渲染），
 * 抽出来零耦合——参照 `SshTerminalMoreMenu.tsx` 先例。
 *
 * 用视口坐标（`MouseEvent.clientX/clientY`）而不是容器内相对坐标：终端容器带
 * `overflow-hidden`，菜单挂在里面会被裁掉（详见 SshTerminalMenu 的头注）。
 */
export function SshTerminalContextMenu({
  containerRef,
  hasSelection,
  pasteDisabled,
  onCopy,
  onPaste,
  onSelectAll,
}: Props) {
  const [pos, setPos] = useState<TerminalMenuPos | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setPos({ x: e.clientX, y: e.clientY });
    };
    container.addEventListener("contextmenu", onContextMenu);
    return () => container.removeEventListener("contextmenu", onContextMenu);
  }, [containerRef]);

  if (!pos) return null;
  return (
    <SshTerminalMenu
      pos={pos}
      hasSelection={hasSelection()}
      pasteDisabled={pasteDisabled}
      onCopy={onCopy}
      onPaste={onPaste}
      onSelectAll={onSelectAll}
      onClose={() => setPos(null)}
    />
  );
}
