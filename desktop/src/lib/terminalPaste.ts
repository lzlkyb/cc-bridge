/**
 * 多行粘贴的判定与预览（纯函数，便于单测）。
 *
 * WHY 要拦：多行内容粘进终端会被远端 shell **逐行执行**，不会等用户再按回车。
 * iTerm2 / Windows Terminal / VS Code 全都会先问一句。
 */

/** 确认框里最多展示几行原文。 */
export const PASTE_PREVIEW_LINES = 3;

/** 按行拆分，并丢掉**末尾的单个换行**（它只是把最后一条命令提交掉，不多一条）。 */
function splitLines(text: string): string[] {
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

/**
 * 粘贴内容会被远端当成几条命令执行。
 *
 * 末尾换行不计数：`"ls\n"` 与手敲 `ls` 再回车等价，没必要弹框。
 */
export function countPasteLines(text: string): number {
  if (!text) return 0;
  return splitLines(text).length;
}

/**
 * 确认框里的内容预览：最多 `PASTE_PREVIEW_LINES` 行，超出部分折成一句「…还有 N 行」。
 */
export function pastePreview(text: string): string {
  const lines = splitLines(text);
  if (lines.length <= PASTE_PREVIEW_LINES) return lines.join("\n");
  const rest = lines.length - PASTE_PREVIEW_LINES;
  return [...lines.slice(0, PASTE_PREVIEW_LINES), `…还有 ${rest} 行`].join("\n");
}
