import type { Terminal } from "@xterm/xterm";

/** 重连分隔线：告诉用户「中间断过一次」，否则新提示符直接接在旧输出后面看不出断过。 */
export const RECONNECTED_MARK = "\r\n\x1b[36m[已重新连接]\x1b[0m\r\n";

/**
 * 会话**重连**（sessionId 换了、但不是首次挂载）后的终端收尾。
 *
 * WHY 抽成函数：这三件事只在「点重新连接」时发生，漏一件用户就会觉得没连上——
 * ① 不画分隔线：新旧输出连在一起，看不出断过；
 * ② 不滚到底：重连**不重建** xterm（历史要保住），视口还停在断开前的历史位置，
 *    新提示符落在可视区外，屏幕上全是旧内容 ⇒ 用户判成「没连上」；
 * ③ 不清输入失败红标：那是上个会话「输入没发出去」的结论，新会话一次输入都还没试。
 */
export function markReconnected(term: Pick<Terminal, "write" | "scrollToBottom">): void {
  term.write(RECONNECTED_MARK);
  term.scrollToBottom();
}
