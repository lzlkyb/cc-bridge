import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { Root } from "hast";
import { Icon } from "../ui/icon";
import type { CcMark } from "../../lib/ccMarkdown";
import { highlightCode } from "../../lib/ccCodeHighlight";
import { splitLeafText } from "./MarkedText";
import { CodeCopyButton } from "./CodeCopyButton";
import "./code.css";

/** 超过这么多行就默认折叠。14 行 ≈ 288px，再长会把一屏正文顶出去。 */
const CODE_FOLD_LINES = 14;

/**
 * 从整段命中标注里取出与 `[from, to)` 相交的那部分，并把区间改写成节点内偏移。
 *
 * 高亮把代码切成了几十个 `<span>`，而命中区间是**整段代码**的字符偏移 —— 每个
 * 文本节点都要做一次这个换算，否则高亮会标到相邻的字上（`splitLeafText` 只认
 * 「该字符串内部的区间」）。
 */
function sliceMarks(marks: CcMark[] | undefined, from: number, to: number): CcMark[] | undefined {
  if (!marks || marks.length === 0) return undefined;
  const out: CcMark[] = [];
  for (const m of marks) {
    const start = Math.max(m.start, from);
    const end = Math.min(m.end, to);
    if (start < end) out.push({ ...m, start: start - from, end: end - from });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * hast → React 元素。只认 `text` 与 `element`（lowlight 只产出这两种，元素恒为
 * `<span class="hljs-…">`）。**不用 innerHTML** —— 与 `ccMarkdown.ts` 同一条纪律。
 *
 * `state.off` 是「当前文本节点在整段代码里的起点」，渲染期递增（与 seg 游标同一个
 * 模式：纯函数、每次渲染重置）。
 */
function renderHast(nodes: Root["children"], state: { off: number; marks?: CcMark[] }): ReactNode {
  return nodes.map((node, i) => {
    if (node.type === "text") {
      const start = state.off;
      state.off += node.value.length;
      const marks = sliceMarks(state.marks, start, state.off);
      return <Fragment key={i}>{marks ? splitLeafText(node.value, marks) : node.value}</Fragment>;
    }
    if (node.type === "element") {
      const cls = node.properties?.className;
      const className = Array.isArray(cls) ? cls.join(" ") : typeof cls === "string" ? cls : undefined;
      return (
        <span key={i} className={className}>
          {renderHast(node.children, state)}
        </span>
      );
    }
    return null;
  });
}

/**
 * 代码块：语言角标 + 语法高亮 + 复制 + 超长折叠。
 *
 * 折叠用 state 而不是「240px 内滚之后就不管了」：内滚框和页面滚动形成嵌套滚动，
 * 触控板手势极易误滚到页面，读长代码时体验明显更差（审查 P1-5）。折叠态只保留
 * 一个可点的「展开全部 N 行」，展开后不再限制高度（交给页面滚）。
 *
 * 高亮失败（语言没注册 / 语法抛错）时退回纯文本 —— 代码必须永远看得见。
 * 复制按钮（`CodeCopyButton`）自己持有「已复制」状态，不把整条 Markdown 拖着重渲染。
 */
export function CodeBlock({ code, lang, marks }: { code: string; lang: string; marks?: CcMark[] }) {
  const lineCount = useMemo(() => code.replace(/\n$/, "").split("\n").length, [code]);
  const collapsible = lineCount > CODE_FOLD_LINES;
  const [expanded, setExpanded] = useState(false);
  const clipped = collapsible && !expanded;
  const tree = useMemo(() => highlightCode(code, lang), [code, lang]);
  const body = useMemo(
    () => (tree ? renderHast(tree.children, { off: 0, marks }) : splitLeafText(code, marks)),
    [tree, code, marks],
  );
  return (
    <div className="cc-codeblock group/mdcode relative my-2 rounded-r-md border-l-2 border-border bg-muted/25">
      <div className="flex h-4 items-center justify-between px-2.5 pt-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{lang}</span>
        {collapsible && (
          <span className="font-mono text-[11px] text-muted-foreground/80">
            {expanded ? `${lineCount} 行` : `${lineCount} 行 · 已折叠`}
          </span>
        )}
      </div>
      <pre
        data-cc-inset
        className={`overflow-x-auto whitespace-pre px-2.5 pb-2 pt-1 pr-14 font-mono text-[12px] leading-[1.6] ${clipped ? "max-h-[288px] overflow-y-hidden" : ""}`}
      >
        {body}
      </pre>
      <CodeCopyButton text={code} className="absolute right-1.5 top-1.5 opacity-0 group-hover/mdcode:opacity-100" />
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-center gap-1 border-t border-border/60 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <Icon name={expanded ? "chevronUp" : "chevronDown"} size={11} />
          {expanded ? "收起" : `展开全部 ${lineCount} 行`}
        </button>
      )}
    </div>
  );
}
