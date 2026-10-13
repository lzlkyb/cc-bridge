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

/**
 * 是否需要「两段式确认」：内容含换行 **且** 远端没开 bracketed paste。
 *
 * bracketed paste 开着（bash/zsh/fish/vim/Claude Code……）→ 整块插入不执行，放行；
 * 没开 → 换行会逐行执行，这是唯一真正危险的场景（脚本炸弹）。
 * 判定用原始文本（含 `\n` 或 `\r`），而不是 normalize 后的——语义是「用户要粘多行」。
 */
export function shouldConfirmPaste(text: string, bracketed: boolean): boolean {
  if (bracketed) return false;
  return /\r|\n/.test(text);
}

/**
 * 复制前逐行剥掉**行尾**空白（空格/制表符）。
 *
 * 依据：Claude Code 用户高频抱怨复制内容带尾随空格与缩进（anthropics/claude-code#18170），
 * 粘进编辑器/文档很脏。行**内部**的空白（对齐列、ASCII 表格）一律不动，
 * 只处理「光标到行尾之间」的部分——xterm 选区按 cell 网格取字，行尾空白来自
 * 未写字符的底色 cell，几乎从来不是内容本身。
 */
export function trimCopyText(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      // (?=\r?$)：xterm 在 Windows 上用 \r\n 连行（SelectionService.ts:259），
      // 行尾空白在 \r 之前——不用前瞻就永远剥不到（本机实测假绿过）。
      line.replace(/[ \t]+(?=\r?$)/, ""),
    )
    .join("\n");
}

/**
 * 路径按需加 POSIX 单引号：插入终端输入行的远端路径若含空格/括号/`$` 等，
 * 会被 shell 切词或展开。安全字符集 = bash 手册里「无需引用」的集合
 * （字母数字 + `_@%+=:,./-`）；已含单引号的用 `'\''` 拼接。
 */
export function quoteShellArgIfNeeded(path: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
