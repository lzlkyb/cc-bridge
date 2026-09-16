/**
 * 粘贴内容在发给远端 PTY 之前的规范化与包裹（纯函数，便于单测）。
 *
 * WHY 要包裹：多行内容直发 PTY，远端 shell 会**逐行执行**。而远端应用（bash/zsh 的
 * readline、vim、less 等）开启 bracketed paste（DECSET 2004）后，终端把内容包在
 * `ESC[200~ … ESC[201~` 里，它就把整块内容插进编辑缓冲区**显示成多行**、不执行，
 * 等用户自己按回车——这正是"粘贴就是插入"的语义。
 *
 * 因此这里**不统计行数、不做任何拦截**：能不能"只显示不执行"由远端模式决定，
 * 交给 `preparePaste(text, term.modes.bracketedPasteMode)` 处理。
 */

/** bracketed paste 的起止标记（DECSET 2004）。 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * 内容里自带的起止标记要剥掉：不剥的话，粘贴内容中的 `ESC[201~` 会提前闭合包裹，
 * 后面的内容落回裸发状态、重新变成逐行执行。
 *
 * 用全局正则而非 `replaceAll`：tsconfig 的 target/lib 都是 ES2020，没有 `replaceAll`。
 */
// eslint-disable-next-line no-control-regex -- 要匹配的就是 ESC(0x1b) 控制字符
const PASTE_MARKERS = /\x1b\[20[01]~/g;

/**
 * 换行规范化：`\r?\n → \r`（与 xterm 的 `terminal.paste()` 一致）。
 *
 * CR 才是"回车"的正解——只发 LF 要靠 PTY 的 ICRNL 兜着才换行，raw 模式下不一定生效。
 * 且换行统一成 CR 后，bracketed paste 里 readline 才会把每段渲染成独立的一行。
 */
export function normalizePaste(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

/**
 * 组装最终发给 PTY 的字节。
 *
 * @param bracketed 远端当前是否处于 bracketed paste 模式，取
 *   `term.modes.bracketedPasteMode`（由远端应用的输出流实时声明）。
 *   - true：内容整块插入编辑缓冲区，显示多行、不执行。
 *   - false：原样发送，远端会逐行执行——终端协议里没有"多行且不执行"的第三种表达，
 *     此时"不打断用户"与"不逐行执行"只能二选一。
 */
export function preparePaste(text: string, bracketed: boolean): string {
  const normalized = normalizePaste(text);
  if (!bracketed) return normalized;
  return PASTE_START + normalized.replace(PASTE_MARKERS, "") + PASTE_END;
}
