import type { IBufferNamespace } from "@xterm/xterm";

/**
 * 导出 xterm 可视区域为纯文本（「复制整屏」用）。
 *
 * 不依赖选区：远端 TUI 开着鼠标报告时本地选区建不起来（见 lib/terminalMouse.ts），
 * 这是唯一可靠的整屏复制路径。从 viewportY 开始取 rows 行，越界行取空串，
 * 行尾空白修剪（translateToString(true) 之外的双保险）。
 */
export function screenToText(buffer: IBufferNamespace, rows: number): string {
  const active = buffer.active;
  const start = active.viewportY;
  const lines: string[] = [];
  for (let i = start; i < start + rows; i++) {
    const line = active.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\n").replace(/[ \t]+$/gm, "");
}
