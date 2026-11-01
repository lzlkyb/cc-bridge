/**
 * Markdown 的词法与「文本叶子」抽取（对话页正文渲染 + 会话内搜索共用）。
 *
 * 为什么走 lexer → React 而不是 parse → innerHTML：整条链路只产出 React 元素，
 * 文本自动转义，**不引 DOMPurify 也不碰 dangerouslySetInnerHTML**；
 * 交互件（代码块复制按钮）是天然组件而不是事件委托。
 *
 * `breaks: true`（单换行 = <br>）：老版 MessageText 是 pre-wrap，单换行本来就
 * 换行显示；模型流式输出里单换行分段很常见，按标准 Markdown 折叠成空格是退化。
 */
import { marked, type Token, type Tokens } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/**
 * 一条命中标注：`seg` = 该消息内文本叶子的序号（见 `walkTextLeaves`），
 * `start/end` = 叶子内字符区间（按 JS 码点下标，与 String.slice 同口径）。
 */
export type CcMark = { seg: number; start: number; end: number; current?: boolean };

export function lexMarkdown(text: string): Token[] {
  return marked.lexer(text);
}

/** 一个顶层块：原始源码 + 该块**首个**文本叶子的 seg 序号。 */
export type CcBlock = {
  key: number;
  raw: string;
  seg: number;
  /**
   * 这一块是围栏代码块（top-level `code` token）。
   *
   * 只有一个消费者：`MarkdownText` 决定流式光标放不放 —— 末块是代码块时，
   * 光标会落在 `<pre>` 的右外侧，看着像代码里多了个字符。判定用 token 类型而不是
   * 对 `raw` 做正则：缩进代码块、`~~~` 围栏、列表里的代码都能一次判对。
   */
  code: boolean;
};

/**
 * 把整段 markdown 按 **top-level token** 切成块，并给出每块的起始 `seg`。
 *
 * 🔴 为什么要切：`marked.lexer` 的结果是整段的一个数组，`MarkdownText` 以前把
 *    整个数组一次性渲染成元素树，而 `useMemo` 的依赖是**累计的整段文本** ⇒
 *    流式期间每个碎片都让整棵树重建一次，单条回复的累计代价随长度平方增长。
 *    切成块之后 `raw` 相同的块 memo 命中，只有尾巴那一块重建。
 *
 * 🔴 `seg` 必须**跨块连续**：渲染是分块进行的，但会话内搜索的 `CcMark.seg`
 *    是全消息的一个连续序号。所以这里先把每块的起点算出来传给块组件，
 *    块内从那个起点往后递增（见 `walkTextLeaves` 头注那条同构红线）。
 *
 * `token.raw` 是该块的原始源码，重新 `lexMarkdown(raw)` 得到的是同一块 —— 这条等价性
 * （含逐块重词法的叶子序列必须与整段 `markdownLeaves` 逐字相等）的守门测试在
 * `lib/ccMarkdown.test.ts` 的 `describe("splitBlocks")`。
 */
export function splitBlocks(text: string): CcBlock[] {
  const tokens = lexMarkdown(text);
  const out: CcBlock[] = [];
  let seg = 0;
  tokens.forEach((t, key) => {
    out.push({ key, raw: (t as { raw?: string }).raw ?? "", seg, code: t.type === "code" });
    walkTextLeaves([t], () => {
      seg += 1;
    });
  });
  return out;
}

/**
 * 按渲染顺序访问所有「文本叶子」—— 段落/标题/强调/链接的正文、行内代码、
 * fenced 代码块、表格单元格、引用块……
 *
 * 🔴 与 `MarkdownText` 的渲染递归**同构**：两边必须按同一顺序访问叶子，
 *    会话内搜索的命中区间（seg + start）才能落到正确的叶子上。
 *    改这个函数的遍历顺序 = 改渲染顺序，必须两边一起动（测试锁着对齐例）。
 */
export function walkTextLeaves(tokens: Token[], visit: (text: string) => void): void {
  for (const t of tokens) {
    switch (t.type) {
      case "paragraph":
      case "heading":
        walkInlineLeaves((t as Tokens.Paragraph | Tokens.Heading).tokens, visit);
        break;
      case "blockquote":
        walkTextLeaves((t as Tokens.Blockquote).tokens, visit);
        break;
      case "code":
        visit((t as Tokens.Code).text);
        break;
      case "table": {
        const tb = t as Tokens.Table;
        for (const cell of tb.header) walkInlineLeaves(cell.tokens, visit);
        for (const row of tb.rows) for (const cell of row) walkInlineLeaves(cell.tokens, visit);
        break;
      }
      case "list": {
        for (const item of (t as Tokens.List).items) walkTextLeaves(item.tokens, visit);
        break;
      }
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length > 0) walkInlineLeaves(tt.tokens, visit);
        else visit(tt.text);
        break;
      }
      case "html":
        visit((t as Tokens.HTML).text);
        break;
      default: {
        // 未知块级 token：有子 tokens 就递归，有 text 就当叶子 ——
        // 新版本 marked 增加形态时不至于静默丢内容。
        const any = t as { tokens?: Token[]; text?: string };
        if (any.tokens && any.tokens.length > 0) walkTextLeaves(any.tokens, visit);
        else if (typeof any.text === "string") visit(any.text);
      }
    }
  }
}

function walkInlineLeaves(tokens: Token[], visit: (text: string) => void): void {
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length > 0) walkInlineLeaves(tt.tokens, visit);
        else visit(tt.text);
        break;
      }
      case "escape":
        visit((t as Tokens.Escape).text);
        break;
      case "codespan":
        visit((t as Tokens.Codespan).text);
        break;
      case "strong":
      case "em":
      case "del":
        walkInlineLeaves((t as Tokens.Strong).tokens, visit);
        break;
      case "link":
      case "image":
        walkInlineLeaves((t as Tokens.Link).tokens, visit);
        break;
      case "html":
        visit((t as Tokens.HTML).text);
        break;
      case "br":
      default:
        break;
    }
  }
}

/** 按渲染顺序抽出全部叶子文本（搜索索引用：叶子序号即 `CcMark.seg`）。 */
export function markdownLeaves(text: string): string[] {
  const out: string[] = [];
  walkTextLeaves(lexMarkdown(text), (s) => out.push(s));
  return out;
}
