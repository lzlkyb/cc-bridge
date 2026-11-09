import type { IBuffer } from "@xterm/xterm";
import { saveTextExport } from "./exportFile";

/**
 * 会话导出：把整个滚动缓冲区取成纯文本、再落成文件。
 *
 * 取 **0 … baseY+cursorY**（全历史）而不是可视区——「导出会话」的价值就在于把
 * 已经滚出屏幕的输出也带走；可视区那份已经有「复制整屏」了（`terminalScreen.ts`）。
 *
 * 落盘走「另存为」+ 后端写文件（`lib/exportFile.ts`）。早先用 Blob + `a.download`，
 * WebView2 会静默存进系统「下载」、不给路径，用户找不到文件（2026-11-09 改）。
 */
export function bufferToText(buffer: IBuffer): string {
  const last = buffer.baseY + buffer.cursorY;
  const lines: string[] = [];
  for (let i = 0; i <= last; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  // 剥尾部空行：屏幕通常没写满，缓冲区底部留着一片空白，不剥的话导出的 .txt 末尾
  // 拖一长段空行（几百行），既难看又影响 diff。
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * 导出文件名：`<连接名>-<yyyyMMdd-HHmmss>.log`。
 * 连接名里的文件系统非法字符与空白换成 `-`（连接名是用户随手起的，什么都可能有）；
 * 全被替换掉时回退 `terminal`。
 */
export function exportFileName(name: string, at: Date = new Date()): string {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "terminal";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${safe}-${stamp}.log`;
}

/**
 * 弹「另存为」保存终端会话，返回实际路径（用户取消返回 null）。
 * 调用方负责先确认文本非空（空文件导出没有意义，也容易让用户以为坏了）。
 */
export function saveTerminalLog(filename: string, text: string): Promise<string | null> {
  return saveTextExport({
    title: "导出终端会话",
    defaultName: filename,
    ext: "log",
    filterName: "日志文本",
    content: text,
  });
}
