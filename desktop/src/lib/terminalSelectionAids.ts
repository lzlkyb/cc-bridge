import type { Terminal } from "@xterm/xterm";
import { attachCellDoubleClick, type CellDoubleClickOptions } from "./terminalCellSelect";
import { attachContextMenuGuard } from "./terminalContextMenu";
import { attachSelectionKeepGuard } from "./terminalSelectionKeep";

/**
 * 选区辅助守卫的统一装配点：右键保住选区 / 松手后保活 / 双击取单元格。
 *
 * WHY 收成一个入口：三者在调用方是三次样板装配 + 三次注销，而 `useSshTerminalSelect`
 * 贴着 300 行棘轮线；更要紧的是**注册顺序**——双击必须第一个挂（见下），
 * 分散在调用处时很容易被人调整顺序而静默失效。
 *
 * 🔴 顺序敏感：双击用 `stopImmediatePropagation` 挡掉同容器上后续注册的
 * 「选择模式起手」合成事件；排在它后面注册就挡不住，单元格选区会被冲成线性选区。
 * 另两个与顺序无关（右键走 pointerdown，保活走 mousemove）。
 */
export function attachSelectionAids(
  term: Terminal,
  container: HTMLElement,
  opts: CellDoubleClickOptions = {},
): () => void {
  const detachCell = attachCellDoubleClick(term, container, opts);
  const detachMenu = attachContextMenuGuard(term, container);
  const detachKeep = attachSelectionKeepGuard(term, container);
  return () => {
    detachCell();
    detachMenu();
    detachKeep();
  };
}
