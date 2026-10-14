import type { IBuffer } from "@xterm/xterm";

/**
 * 会话导出：把整个滚动缓冲区取成纯文本、再落成文件。
 *
 * 取 **0 … baseY+cursorY**（全历史）而不是可视区——「导出会话」的价值就在于把
 * 已经滚出屏幕的输出也带走；可视区那份已经有「复制整屏」了（`terminalScreen.ts`）。
 *
 * 🔴 用 Blob + `a.download` 而不是保存对话框：`dialog:allow-save` 权限没开，
 * 而写盘要再引 `tauri-plugin-fs`（多一个 Rust 依赖）。审计日志导出
 * （`LogExportMenu.tsx`）走的就是 Blob，这里保持一致——WebView2 会落到系统下载目录。
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

/** 触发下载。调用方负责先确认文本非空（空文件导出没有意义，也容易让用户以为坏了）。 */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
