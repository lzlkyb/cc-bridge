import type { Terminal } from "@xterm/xterm";

/**
 * 关掉本地 xterm 鼠标报告的转义序列：全部四种追踪模式（1003 任意移动 / 1002 按键
 * 拖拽 / 1000 按键 / 9 X10）。全部关闭，顺序无所谓。
 *
 * 🔴 **刻意不关 1006（SGR 编码）**：1006 只是编码标记，追踪模式全关时它不起作用；
 * 远端（Claude Code 每帧重绘都发 ?1006h）从未关过它，本地也不关，保持两边一致。
 *
 * ⚠️ **本序列只在一处使用：会话接线/断开时的「治愈」**（见 healMouseTracking）。
 * 选择手势期间**不再**用它——那条路改走 `terminalInputHold` 的输入闸，理由见该文件头注
 * （写 DECRST 会把滚轮归属打成 dead 态，恢复失败就是永久死窗）。
 */
export const MOUSE_REPORT_OFF = "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l";

/**
 * 治愈本地 xterm 残留的鼠标报告（会话断开 / 换会话接线时调用）。
 *
 * 远端 TUI（Claude Code）会发 ?1003h+?1006h 开启「任意移动」鼠标追踪；连接断开时
 * TUI 进程随之死亡、来不及发 DECRST，而终端实例是刻意跨重连保留的（历史输出要可读，
 * 见 useSshTerminalSession 创建 effect 的依赖说明），`mouseTrackingMode` 就残留为
 * "any"。重连后的新会话是裸 bash，不消费鼠标报告：此后任何鼠标移动/滚轮都会被 xterm
 * 编码成 SGR 序列（`ESC[<35;x;yM`）发给它、原样回显成一屏乱码
 * （2026-10-12 用户报障：重连后自动输入乱码，滚轮滚动继续吐）。
 *
 * 这是**有意的永久性本地状态修正**（新会话是裸 shell，本就不该有鼠标报告），
 * 与「选择手势临时借走协议」是两回事——后者已废弃。
 */
export function healMouseTracking(term: Terminal): void {
  if (!mouseTrackingActive(term)) return;
  term.write(MOUSE_REPORT_OFF);
}

/**
 * 本地 xterm 是否处于鼠标追踪态（= 远端程序开着）。选择手势「强制起选区」的判据。
 * 契约残缺（半销毁终端 / 缺字段）一律当 false——选择手势的热路径上不能抛。
 */
export function mouseTrackingActive(term: Terminal): boolean {
  const mode = term?.modes?.mouseTrackingMode;
  return mode !== undefined && mode !== "none";
}
