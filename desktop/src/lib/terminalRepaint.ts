import type { Terminal } from "@xterm/xterm";

/**
 * 一键强制重绘（Claude Code 花屏/残影自救）。
 *
 * 背景：Claude Code 的差分渲染器在 Windows Terminal / 长会话 / Agent View 切换等
 * 场景会把旧帧内容残留在屏幕上（anthropics/claude-code#79025、#78890——根因是它
 * 有时发 CUF「光标前移」跳过 cell 而不写空格）。社区共识的**唯一自救**是手动拖一下
 * 窗口大小触发全量重绘。这里把那一步做成程序化动作：
 *
 * resize 会强制 xterm 重排整个缓冲区并全量重画——正是「拖窗口」起效的机制。
 * cols-1 → cols 来回一次，行数不动（不动 rows 是避免触发 doFit/字体重算的连锁）。
 * cols=1 时减不出列，直接跳过（理论边界，真实终端最小也有 2 列以上）。
 */
export function forceRepaint(term: Terminal | null): void {
  if (!term) return;
  const { cols, rows } = term;
  if (cols < 2 || rows < 1) return;
  term.resize(cols - 1, rows);
  term.resize(cols, rows);
}
