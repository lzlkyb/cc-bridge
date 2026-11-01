import { useMemo } from "react";
import { splitBlocks, type CcMark } from "../../lib/ccMarkdown";
import { MarkdownBlock } from "./MarkdownBlock";

/**
 * 助手正文的 Markdown 渲染入口：marked 词法 → React 元素（无 innerHTML，见
 * `lib/ccMarkdown.ts` 头注）。视觉沿设计稿《对话页-Markdown与TodoWrite卡片》：
 * 代码块 = MonoBlock 的延伸（border-l-2 家族 + 语言角标 + 悬浮复制），
 * 标题字号往下压（对话流里标题是分节提示，不是文档页大标题）。
 *
 * 2026-11 改成**块级 memo**：`splitBlocks` 把 top-level token 切开，每块单独成
 * 组件（`MarkdownBlock`）、以 `raw` 为 memo 键。流式期间只有尾巴那一块重建元素树，
 * 已完成的块原样复用 —— 这是长回复从「每次碎片全量重渲染」变成「只渲染新增内容」
 * 的关键。块内递归渲染在 `MarkdownBlock`，代码块在 `CodeBlock`。
 *
 * 🔴 `seg`（会话内搜索的叶子上标）必须**跨块连续**：起点由 `splitBlocks` 算好，
 *    块内从那个值往后递增。改这里或 `walkTextLeaves` 的遍历顺序必须两边一起动。
 */
function groupBySeg(marks?: CcMark[]): Map<number, CcMark[]> {
  const m = new Map<number, CcMark[]>();
  if (!marks) return m;
  for (const mark of marks) {
    const list = m.get(mark.seg);
    if (list) list.push(mark);
    else m.set(mark.seg, [mark]);
  }
  return m;
}

function MarkdownTextImpl({ text, marks, streaming = false }: { text: string; marks?: CcMark[]; streaming?: boolean }) {
  const marksBySeg = useMemo(() => groupBySeg(marks), [marks]);
  const blocks = useMemo(() => (text ? splitBlocks(text) : []), [text]);
  // `raw` 相同 ⇒ 内容相同（`token.raw` 就是该块的源码），所以 memo 键安全。
  //
  // 流式光标（P0-2）：
  // 🔴 必须渲染在块序列**之外**（容器的最后一个兄弟节点），不能塞进 `MarkdownBlock`
  //    或 `walkTextLeaves` 的遍历里 —— 那会让 `seg` 下标整体错位，会话内搜索变成
  //    「计数说命中、界面标错字」。也不进 memo 键：光标由 `streaming` 驱动，与块内容无关。
  // 末块是围栏代码块时不放：光标会落在 `<pre>` 右外侧，看起来像代码里多了个字符；
  // 那种情况交给底部浮条（`StreamHud`）说明「还在跑」。
  const last = blocks[blocks.length - 1];
  const caret = streaming && !(last?.code ?? false);
  return (
    <div className="min-w-0 break-words text-[length:var(--cc-chat-fs,13px)] leading-[var(--cc-chat-lh,1.72)] text-foreground [&>*:last-child]:mb-0">
      {blocks.map((b) =>
        b.raw ? <MarkdownBlock key={b.key} raw={b.raw} startSeg={b.seg} marksBySeg={marksBySeg} /> : null,
      )}
      {caret && <span className="cc-caret" aria-hidden="true" />}
    </div>
  );
}

export const MarkdownText = MarkdownTextImpl;
