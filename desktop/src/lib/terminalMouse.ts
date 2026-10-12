import type { Terminal } from "@xterm/xterm";

/**
 * 关掉本地 xterm 鼠标报告的转义序列：SGR 扩展编码（1006）+ 三种追踪模式
 * （1003 任意移动 / 1002 按键拖拽 / 1000 按键）。全部关闭，顺序无所谓。
 *
 * 🔴 关键：这串转义必须用 `term.write()` 写给【本地 xterm 的输出流】。曾经错误地经
 * `ssh_input` 发给远端 PTY(stdin)——xterm 从来不会解析它，而 xterm 的
 * mouseTrackingMode 只由「输出流」里的转义控制；Claude Code 又在自己的输出里反复
 * ESC[?1006h，于是本地鼠标报告一直开着、拖选被吃掉、`term.getSelection()` 恒空。
 *
 * ⚠️ 但仅"关掉"还不够（headless xterm 6.0 实测）：选区只能在 mousedown 时由
 * SelectionService 启动，中途关报告后本次手势的 mousemove 无法凭空建选区——
 * 拖拽路径必须在关报告的 write 回调里补发合成 mousedown（见 useSshTerminalSelect
 * 的 replaySelectionStart）。
 */
export const MOUSE_REPORT_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

/**
 * 治愈本地 xterm 残留的鼠标报告模式（会话断开 / 重连时调用；mode 已是 none 则零写入）。
 *
 * 远端 TUI（Claude Code）会发 ?1003h+?1006h 开启「任意移动」鼠标追踪；连接断开时
 * TUI 进程随之死亡、来不及发 DECRST，而终端实例是刻意跨重连保留的（历史输出要可读，
 * 见 useSshTerminalSession 创建 effect 的依赖说明），`mouseTrackingMode` 就残留为
 * "any"。重连后的新会话是裸 bash，不消费鼠标报告：此后任何鼠标移动/滚轮都会被 xterm
 * 编码成 SGR 序列（`ESC[<35;x;yM`）经 ssh_input 发给它、原样回显成一屏乱码
 * （2026-10-12 用户报障：重连后自动输入乱码，滚轮滚动继续吐）。
 *
 * 断开时也治：会话已死，残留报告会让滚轮事件被 xterm 吞掉（disableStdin 会拦掉
 * 发出的数据，但历史也滚不动）。远端下次跑起 TUI 时会自行重开追踪，无需本地恢复。
 */
export function healMouseTracking(term: Terminal) {
  if (term.modes.mouseTrackingMode !== "none") term.write(MOUSE_REPORT_OFF);
}
