import type { Terminal } from "@xterm/xterm";

/**
 * 「清空输入」：把光标左侧已经敲进去的东西一次性删掉。
 *
 * 为什么需要这么绕：终端里没有输入框。xterm 只是显示层 + 按键转发器，按一次
 * Backspace 就是一个 `0x7f` 发到 PTY，远端（readline / Ink 输入框）才删一个字符。
 * 本地没有输入缓冲，所以「全选再删」不成立（Ctrl+Shift+A 选的是屏幕文本，动不了
 * 远端缓冲）。唯一可行的办法是**按屏幕反推该发多少个 Backspace**。
 *
 * 两条安全边界（判错也不能伤人）：
 * 1. 普通屏（shell）只清光标所在行 —— 上面是命令输出；此刻若有程序在读 stdin
 *    （cat / less），多发出去的 Backspace 会真的喂给它。
 * 2. 备用屏**且光标行带输入框竖线**才向上跨行，且只累计同样带竖线的行，遇框线 / 空行即停。
 *    🔴 「备用屏 = 文本输入框」这个旧假设是错的：vim / nano 也在备用屏，插入模式下
 *    这些 0x7f 就是**删文件内容**（最多 40 行 / 2000 字符）。所以跨行必须有输入框的
 *    正面证据（Ink 边框的竖线），认证据不认屏幕类型；认不出就只清光标行——少删无害，多删致命。
 */

/** Backspace。readline 与 Ink 输入框都按删除一个字符处理，删空后继续按即为无操作。 */
export const BACKSPACE = "\x7f";

/** 单次最多发送多少个：判据万一失效，也别把整屏历史换算成几千次按键。 */
export const MAX_CLEAR_CHARS = 2000;

/** 向上最多看多少行 —— 再高的输入框也到不了这个数。 */
export const MAX_CLEAR_LINES = 40;

/**
 * 只由框线 / 竖线 / 空白构成的行 = 输入框的上下边框。
 * U+2500–U+257F 是制表符方块，Claude Code 的 Ink 输入框用的就是这套字符。
 */
const RULE_ONLY = /^[\s\u2500-\u257F|]+$/;

/**
 * 输入框的竖线（│┃┆┇┊┋）。Ink 的边框逐行都带它，这是「光标在输入框里」的正面证据。
 * 刻意不含半角 `|`：那是 shell 管道 / 表格正文里的常见字符，认它等于把 vim 里的
 * 表格行也当成输入框。
 */
const BOX_VERTICAL = /[\u2502\u2503\u2506-\u250B]/;

export interface ClearInputProbe {
  /** 光标所在行的文本（行尾空白已修剪）。 */
  cursorLine: string;
  /** 光标列号（0 起）。 */
  cursorX: number;
  /** 备用屏（全屏 TUI）。跨行还要再过「光标行带输入框竖线」那道判据。 */
  crossLine: boolean;
  /** 从光标**上一行**起、依次向上的行文本。 */
  upwardLines: readonly string[];
  maxChars?: number;
  maxLines?: number;
}

/**
 * 纯计算：该发多少个 Backspace。
 *
 * 光标行按 `cursorX` 计（左侧可能含输入框竖线 / 提示符，框内多发几个是无操作）；
 * 跨行累计只在**光标行带输入框竖线**时开，且向上每行都要带竖线，遇框线 / 空行 / 无竖线即停。
 */
export function countCharsToClear(p: ClearInputProbe): number {
  const maxChars = p.maxChars ?? MAX_CLEAR_CHARS;
  // 整行只有框线：光标停在空输入框里，没有可删的东西。
  if (RULE_ONLY.test(p.cursorLine) && !p.upwardLines.length) return 0;
  let count = Math.max(0, p.cursorX);
  // 🔴 备用屏 ≠ 输入框：vim / nano 插入模式下跨行发的 0x7f 删的是文件内容（见头注）。
  if (!p.crossLine || !BOX_VERTICAL.test(p.cursorLine)) return Math.min(count, maxChars);
  const maxLines = p.maxLines ?? MAX_CLEAR_LINES;
  const limit = Math.min(maxLines, p.upwardLines.length);
  for (let i = 0; i < limit; i++) {
    const text = p.upwardLines[i];
    if (RULE_ONLY.test(text)) break; // 输入框上边框
    if (!text.trim()) break; // 空行：输入区到顶
    if (!BOX_VERTICAL.test(text)) break; // 出了输入框：上面是编辑器正文 / 对话输出
    count += text.length;
    if (count >= maxChars) break;
  }
  return Math.min(count, maxChars);
}

export interface ClearInputResult {
  /** 实际发送的 Backspace 个数（0 = 没有可清的内容）。 */
  count: number;
  /** 输入闸闭着（拖选手势 / 会话已断开）：没发任何数据。 */
  blocked: boolean;
}

/**
 * 读当前终端缓冲、算出并发出 Backspace。
 *
 * 🔴 走调用方给的 `send`（最终是 `sendTerminalUserInput`），与键盘、粘贴同一条路径，
 * 这样审计、断线提示、输入失败去重都能复用；不要在这里直接 invoke。
 */
export function clearTerminalInput(
  term: Terminal,
  send: (data: string) => void,
): ClearInputResult {
  // 输入闸闭着（terminalInputHold：拖选手势 / 会话断开）时按快捷键不该有动作。
  if (term.options.disableStdin) return { count: 0, blocked: true };
  const buf = term.buffer.active;
  const cursorLine = buf.baseY + buf.cursorY;
  const lineText = (n: number) => (n >= 0 ? (buf.getLine(n)?.translateToString(true) ?? "") : "");
  const crossLine = buf.type === "alternate";
  const upwardLines: string[] = [];
  if (crossLine) {
    for (let i = 1; i < MAX_CLEAR_LINES; i++) {
      if (cursorLine - i < 0) break;
      upwardLines.push(lineText(cursorLine - i));
    }
  }
  const count = countCharsToClear({
    cursorLine: lineText(cursorLine),
    cursorX: buf.cursorX,
    crossLine,
    upwardLines,
  });
  if (count > 0) send(BACKSPACE.repeat(count));
  return { count, blocked: false };
}
