import { useMemo, type ReactNode } from "react";
import type { Token, Tokens } from "marked";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { Icon } from "../ui/icon";
import { lexMarkdown, type CcMark } from "../../lib/ccMarkdown";
import { splitLeafText } from "./MarkedText";

/**
 * 助手正文的 Markdown 渲染：marked 词法 → React 元素（无 innerHTML，见
 * `lib/ccMarkdown.ts` 头注）。视觉沿设计稿《对话页-Markdown与TodoWrite卡片》：
 * 代码块 = MonoBlock 的延伸（border-l-2 家族 + 语言角标 + 悬浮复制），
 * 标题字号往下压（对话流里标题是分节提示，不是文档页大标题）。
 *
 * `marks` 是会话内搜索的命中标注（seg + 区间 + 是否当前命中）。
 * 🔴 `seg` 游标与 `walkTextLeaves` 的访问顺序**同构**（那边头注写明了两边必须一起动）：
 *    渲染期递增、同一输入同一输出，纯度没问题，但**不能**在本组件里做任何
 *    条件渲染叶子的事（比如「空叶子跳过」）—— 渲染顺序漂移 = 命中区间落错叶子。
 */

const HEAD_CLASS: Record<number, string> = {
  1: "mt-3.5 mb-1.5 text-[14px] font-semibold leading-[1.45]",
  2: "mt-3 mb-1.5 text-[13.5px] font-semibold leading-[1.45]",
  3: "mt-2.5 mb-1 text-[13px] font-semibold leading-[1.45]",
  4: "mt-2.5 mb-1 text-[12.5px] font-semibold text-muted-foreground",
};

/** 链接白名单：只放 http(s)/mailto，其余（js:、file:、data:…）按纯文本渲染。 */
function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

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

function MarkdownTextImpl({ text, marks }: { text: string; marks?: CcMark[] }) {
  const tokens = useMemo(() => (text ? lexMarkdown(text) : []), [text]);
  const marksBySeg = useMemo(() => groupBySeg(marks), [marks]);
  const { copy, isCopied } = useCopyFeedback();

  let seg = 0;
  let codeIdx = 0;
  const leaf = (s: string): ReactNode => splitLeafText(s, marksBySeg.get(seg++));

  const inline = (ts: Token[]): ReactNode =>
    ts.map((t, i) => {
      switch (t.type) {
        case "escape":
          return <span key={i}>{leaf((t as Tokens.Escape).text)}</span>;
        case "codespan":
          return (
            <code key={i} data-cc-inset className="mx-px rounded bg-muted px-[3px] py-px font-mono text-[12px] text-foreground/90">
              {leaf((t as Tokens.Codespan).text)}
            </code>
          );
        case "strong":
          return <strong key={i}>{inline((t as Tokens.Strong).tokens)}</strong>;
        case "em":
          return <em key={i}>{inline((t as Tokens.Em).tokens)}</em>;
        case "del":
          return <del key={i}>{inline((t as Tokens.Del).tokens)}</del>;
        case "link": {
          const lt = t as Tokens.Link;
          const href = safeHref(lt.href);
          return href ? (
            <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
              {inline(lt.tokens)}
            </a>
          ) : (
            <span key={i}>{inline(lt.tokens)}</span>
          );
        }
        case "image": {
          // 图片一律按链接渲染（本地无图源，远程图也不该自动拉）。
          // 空_alt_时不走 leaf —— walkTextLeaves 对空 tokens 也不访问，两边一致。
          const it = t as Tokens.Image;
          const href = safeHref(it.href);
          return href && it.tokens.length > 0 ? (
            <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
              {inline(it.tokens)}
            </a>
          ) : null;
        }
        case "br":
          return <br key={i} />;
        case "html":
          return <span key={i}>{leaf((t as Tokens.HTML).text)}</span>;
        default: {
          const tt = t as Tokens.Text;
          return <span key={i}>{tt.tokens && tt.tokens.length > 0 ? inline(tt.tokens) : leaf(tt.text)}</span>;
        }
      }
    });

  const blocks = (ts: Token[], tight = false): ReactNode =>
    ts.map((t, i) => {
      switch (t.type) {
        case "paragraph":
          return (
            <p key={i} className={tight ? "" : "mb-2"}>
              {inline((t as Tokens.Paragraph).tokens)}
            </p>
          );
        case "heading": {
          const ht = t as Tokens.Heading;
          const Tag = (`h${Math.min(ht.depth, 4)}` as "h1" | "h2" | "h3" | "h4");
          return (
            <Tag key={i} className={HEAD_CLASS[Math.min(ht.depth, 4)]}>
              {inline(ht.tokens)}
            </Tag>
          );
        }
        case "code": {
          const ct = t as Tokens.Code;
          const idx = codeIdx++;
          const lang = ct.lang?.trim().split(/\s+/)[0] ?? "";
          return (
            <div key={i} className="group/mdcode relative my-2 rounded-r-md border-l-2 border-border bg-muted/25">
              <div className="flex h-4 items-center px-2.5 pt-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{lang}</span>
              </div>
              <pre data-cc-inset className="max-h-[240px] overflow-auto whitespace-pre px-2.5 pb-2 pt-1 pr-14 font-mono text-[12px] leading-[1.6] text-muted-foreground">
                {leaf(ct.text)}
              </pre>
              <button
                type="button"
                onClick={() => copy(`code:${idx}`, ct.text)}
                title={isCopied(`code:${idx}`) ? "已复制" : "复制代码"}
                aria-label="复制代码"
                aria-live="polite"
                className="absolute right-1.5 top-1.5 flex h-5 items-center gap-1 rounded border border-border bg-card/90 px-1.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/mdcode:opacity-100"
              >
                <Icon name={isCopied(`code:${idx}`) ? "check" : "copy"} size={10} />
                {isCopied(`code:${idx}`) ? "已复制" : "复制"}
              </button>
            </div>
          );
        }
        case "blockquote":
          return (
            <blockquote key={i} className="mb-2 border-l-2 border-warning/55 py-0.5 pl-2.5 text-muted-foreground">
              {blocks((t as Tokens.Blockquote).tokens)}
            </blockquote>
          );
        case "list": {
          const lt = t as Tokens.List;
          const Tag = lt.ordered ? "ol" : "ul";
          const start = typeof lt.start === "number" && lt.start !== 1 ? lt.start : undefined;
          return (
            <Tag key={i} start={start} className={`mb-2 list-inside pl-1 marker:text-muted-foreground ${lt.ordered ? "list-decimal" : "list-disc"}`}>
              {lt.items.map((item, j) => (
                <li key={j} className="my-0.5">
                  {blocks(item.tokens, !lt.loose)}
                </li>
              ))}
            </Tag>
          );
        }
        case "table": {
          const tb = t as Tokens.Table;
          return (
            <div key={i} className="mb-2.5 overflow-x-auto">
              <table className="border-collapse text-[12px]">
                <thead>
                  <tr>
                    {tb.header.map((cell, j) => (
                      <th key={j} style={{ textAlign: cell.align ?? undefined }} className="border border-border bg-muted/60 px-2.5 py-1 font-semibold text-muted-foreground">
                        {inline(cell.tokens)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tb.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((cell, k) => (
                        <td key={k} style={{ textAlign: cell.align ?? undefined }} className="border border-border px-2.5 py-1">
                          {inline(cell.tokens)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        case "hr":
          return <hr key={i} className="my-3 border-t border-border" />;
        case "space":
          return null;
        case "text": {
          const tt = t as Tokens.Text;
          return (
            <p key={i} className={tight ? "" : "mb-2"}>
              {tt.tokens && tt.tokens.length > 0 ? inline(tt.tokens) : leaf(tt.text)}
            </p>
          );
        }
        case "html":
          // 原始 HTML 不解析、原样展示为转义文本 —— 内容不丢，也不开 XSS 面。
          return (
            <p key={i} className="mb-2 font-mono text-[12px] text-muted-foreground">
              {leaf((t as Tokens.HTML).text)}
            </p>
          );
        default: {
          const any = t as { tokens?: Token[]; text?: string };
          return any.tokens && any.tokens.length > 0 ? <div key={i}>{blocks(any.tokens, tight)}</div> : <p key={i}>{leaf(any.text ?? "")}</p>;
        }
      }
    });

  return <div className="min-w-0 break-words text-[length:var(--cc-chat-fs,13px)] leading-[var(--cc-chat-lh,1.72)] text-foreground [&>*:last-child]:mb-0">{blocks(tokens)}</div>;
}

export const MarkdownText = MarkdownTextImpl;
