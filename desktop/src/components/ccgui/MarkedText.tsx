import type { ReactNode } from "react";
import type { CcMark } from "../../lib/ccMarkdown";

/**
 * 单个「文本叶子」按命中标注切片。Markdown 正文（MarkdownText 的叶子）、
 * 用户气泡、思考标题、工具行摘要共用同一实现 —— 会话内搜索的四类命中
 * 才能长得一样（当前命中实底、其余 wash 底，样式类在 index.css）。
 */
export function splitLeafText(s: string, marks?: CcMark[]): ReactNode {
  if (!s) return s;
  if (!marks || marks.length === 0) return s;
  const out: ReactNode[] = [];
  let cursor = 0;
  marks.forEach((m, i) => {
    if (m.start > cursor) out.push(s.slice(cursor, m.start));
    out.push(
      <mark key={i} className={m.current ? "cc-hl-cur" : "cc-hl"} data-cc-hit-cur={m.current || undefined}>
        {s.slice(m.start, m.end)}
      </mark>,
    );
    cursor = m.end;
  });
  if (cursor < s.length) out.push(s.slice(cursor));
  return out;
}

/** 组件形态的便捷封装（调用方自行 memo）。 */
export function MarkedText({ text, marks }: { text: string; marks?: CcMark[] }) {
  return <>{splitLeafText(text, marks)}</>;
}
