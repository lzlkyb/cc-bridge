import { Fragment, memo, useMemo, type ReactNode } from "react";
import type { Token, Tokens } from "marked";
import { lexMarkdown, type CcMark } from "../../lib/ccMarkdown";
import { splitLeafText } from "./MarkedText";
import { CodeBlock } from "./CodeBlock";

/**
 * 一个 top-level Markdown 块的渲染器（`MarkdownText` 按块调用、以 `raw` 做 memo 键）。
 *
 * 🔴 `seg` 游标与 `walkTextLeaves` 的访问顺序**同构**（见 `lib/ccMarkdown.ts` 头注）：
 *    渲染期递增、同一输入同一输出，纯度没问题，但**不能**在这里做任何条件渲染叶子
 *    的事（比如「空叶子跳过」）—— 渲染顺序漂移 = 搜索命中区间落错叶子。
 *    起点由 `splitBlocks` 算好传进来，块内从 `startSeg` 往后递增，全局仍然连续。
 *
 * 从 `MarkdownText` 拆出（2026-11）：那个文件同时承载父级编排与整棵递归渲染，
 * 已经顶到 300 行门禁；这里是纯粹的「一块怎么画」，不持有任何跨块状态。
 *
 * 🔴 本文件里每一条 `case` 都必须与 `lib/ccMarkdown.ts` 的 `walkTextLeaves` /
 *    `walkInlineLeaves` 一一对应（访问顺序与叶子数量），守门测试在
 *    `lib/ccMarkdown.test.ts` 的 `describe("splitBlocks")`。
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

function MarkdownBlockImpl({
  raw,
  startSeg,
  marksBySeg,
}: {
  raw: string;
  /** 本块第一个文本叶子的全局 seg 序号（由 `splitBlocks` 累加得出）。 */
  startSeg: number;
  marksBySeg: Map<number, CcMark[]>;
}) {
  const tokens = useMemo(() => (raw ? lexMarkdown(raw) : []), [raw]);
  // 🔴 渲染期递增，但每次都从 startSeg 重新开始 —— 同一块同一输入必然得到同一组 seg，
  //    严格模式下的双渲染也幂等。
  let seg = startSeg;
  const leaf = (s: string): ReactNode => splitLeafText(s, marksBySeg.get(seg++));

  /**
   * GFM 任务列表的勾选框。
   *
   * 🔴 以前没有这个分支 ⇒ 落进 `default` 读 `text`（checkbox token 没有 `text`，
   *    只有 `raw`/`checked`）⇒ 渲染成空串：已完成项和未完成项在界面上长得一模一样。
   * 🔴 它既可能是**行内** token（松列表：`paragraph > checkbox`），也可能是
   *    **块级** token（紧凑列表：`item.tokens = [checkbox, text]`）—— 两处都要接。
   * `walkInlineLeaves` / `walkTextLeaves` 都不访问它（图标是装饰，不是可搜索的
   * 正文），所以这里也**不消费 seg**，两边一致。
   */
  const checkboxNode = (cb: Tokens.Checkbox, key: number): ReactNode => (
    <span
      key={key}
      role="img"
      aria-label={cb.checked ? "已完成" : "未完成"}
      className={`mr-1 inline-flex h-3.5 w-3.5 translate-y-[1px] items-center justify-center rounded-[3px] border text-[10px] leading-none ${
        cb.checked ? "border-primary/70 bg-primary/15 text-primary" : "border-border text-muted-foreground/60"
      }`}
    >
      {cb.checked ? "✓" : ""}
    </span>
  );

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
          // 🔴 不安全 href 时也必须照常 `inline(tokens)`（以前是直接 return null）：
          //    渲染少访问一次叶子，`seg` 就整体错位一格，后面所有搜索命中全部落到
          //    相邻文本上 —— 这正是 `walkInlineLeaves` 那条同构红线的反面教材。
          const it = t as Tokens.Image;
          const href = safeHref(it.href);
          const kids = inline(it.tokens);
          return href && it.tokens.length > 0 ? (
            <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
              {kids}
            </a>
          ) : (
            <span key={i}>{kids}</span>
          );
        }
        case "checkbox":
          return checkboxNode(t as Tokens.Checkbox, i);
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
        case "paragraph": {
          const kids = inline((t as Tokens.Paragraph).tokens);
          // 🔴 `tight`（紧凑列表，`!lt.loose`）里不能再包 `<p>`：
          // 列表是 `list-inside`，marker 属于**行内**盒。`<li>` 的第一个子元素
          // 一旦是块级元素，marker 就自成一行、正文整体下移缩进 —— 截图里
          // 表现为孤零零一个 `•` 挂在上一行。裸 inline 才和 marker 同行。
          return tight ? <Fragment key={i}>{kids}</Fragment> : <p key={i} className="mb-2">{kids}</p>;
        }
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
          const lang = ct.lang?.trim().split(/\s+/)[0] ?? "";
          // 🔴 显式消费一个 seg（而不是让 `leaf()` 顺带吃掉）：代码块整体是**一个**
          //    叶子（`walkTextLeaves` 对 code 直接 visit 整段 text），高亮把它切成
          //    多个 span 也不改变这一点 —— 命中区间由 `CodeBlock` 按字符偏移映射过去。
          const marks = marksBySeg.get(seg++);
          return <CodeBlock key={i} code={ct.text} lang={lang} marks={marks} />;
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
          // 任务列表的 marker 已经被行内 ✓ 替掉了：再画圆点会变成「• ✓ 事项」。
          const task = lt.items.some((item) => item.task);
          return (
            <Tag
              key={i}
              start={start}
              className={`cc-md-list mb-2 pl-1 marker:text-muted-foreground ${task ? "list-none" : "list-inside"} ${lt.ordered ? "list-decimal" : "list-disc"}`}
            >
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
        case "checkbox":
          // 紧凑列表：`item.tokens = [checkbox, text]`，勾选框落在**块级**这一层
          // （松列表则在 paragraph 的行内 tokens 里）。两种形态都必须接住。
          return checkboxNode(t as Tokens.Checkbox, i);
        case "text": {
          const tt = t as Tokens.Text;
          const kids = tt.tokens && tt.tokens.length > 0 ? inline(tt.tokens) : leaf(tt.text);
          // 同上：紧凑列表里裸 inline，否则 marker 单独占一行。
          return tight ? <Fragment key={i}>{kids}</Fragment> : <p key={i} className="mb-2">{kids}</p>;
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
          if (any.tokens && any.tokens.length > 0) return <div key={i}>{blocks(any.tokens, tight)}</div>;
          // 既没有 tokens 也没有 text 的未知形态（如未来版本的占位 token）：
          // 返回 null 而**不是** `leaf("")`，否则渲染会凭空消费一个 seg，与
          // `walkTextLeaves` 的 default 分支（两个都没有就不访问）分叉。
          if (typeof any.text !== "string") return null;
          return <p key={i}>{leaf(any.text)}</p>;
        }
      }
    });

  return <>{blocks(tokens)}</>;
}

export const MarkdownBlock = memo(MarkdownBlockImpl);
