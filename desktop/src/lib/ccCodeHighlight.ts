import { createLowlight } from "lowlight";
import type { Root } from "hast";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";

/**
 * 代码块语法高亮（对话页，2026-11 审查 P1-5）。
 *
 * ## 为什么是 lowlight 而不是 Shiki / Monaco
 * - Shiki：每个语言 grammar 走 oniguruma wasm，光是运行时就是 600KB 起步，
 *   而这个产品的核心卖点之一是安装包小（≤20MB）。为一个代码块不值。
 * - Monaco：整个编辑器 ≈ 5MB，定位完全不对（这里不是 IDE）。
 * - `lowlight` = highlight.js 的语法 + hast 输出。**输出是 JSON 树而不是 HTML 字符串**，
 *   正好接上本项目「lexer → React 元素、绝不 innerHTML」的主线（见 `ccMarkdown.ts` 头注）。
 *   highlight.js 本身只作为语法来源，我们只 register 这 13 种常用语言，
 *   没用到的语言不会进 bundle。
 *
 * ## 与搜索索引的关系（同构红线）
 * 高亮把代码切成很多 `<span>`，但**文本叶子仍然只有一个**（整段代码）：
 * `walkTextLeaves` 对 `code` token 直接 `visit(text)`，渲染侧也只有一个 seg。
 * 所以 `MarkdownBlock` 只把 seg 的起点告诉 `CodeBlock`，后者把命中区间按字符偏移
 * 映射到 hast 的各个文本节点上（`renderHast` 里的 `off` 累加）。切分方式变了，
 * 叶子口径没变。
 */
const lowlight = createLowlight({
  javascript,
  typescript,
  python,
  rust,
  go,
  json,
  bash,
  css,
  xml,
  yaml,
  sql,
  markdown,
  diff,
  ini,
});

/**
 * 常用别名的兜底映射。
 *
 * highlight.js 的 grammar 自带 `aliases`（js/jsx/mjs、ts/tsx、py、sh/shell/zsh、
 * yml、html/vue），但模型写 fence 时花样更多：`tsx`、`jsx`、`node`、`text`、
 * `plaintext`、`console`。这里补一层，**不做模糊匹配**（`contains` 会把
 * `objective-c` 判成 c，把 `jsonl` 判成 json —— 那属于猜）。
 */
const ALIAS: Record<string, string> = {
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  tsx: "typescript",
  node: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  htm: "xml",
  html: "xml",
  svg: "xml",
  md: "markdown",
  patch: "diff",
  toml: "ini",
  conf: "ini",
};

/**
 * 把一段代码高亮成 hast 树；语言未知 / 空代码返回 `null`（调用方退回纯文本）。
 *
 * 同步 API：lowlight 的 highlight 是纯同步计算，且代码块通常 < 200 行，
 * 一次几毫秒。异步化会把 `useMemo` 变成一个状态机，不值得。
 */
export function highlightCode(code: string, lang: string): Root | null {
  const key = (ALIAS[lang.toLowerCase()] ?? lang.toLowerCase()).trim();
  if (!key || !code) return null;
  if (!lowlight.registered(key)) return null;
  try {
    return lowlight.highlight(key, code);
  } catch {
    // 语法自身抛错（畸形输入）不该让整个代码块渲染不出来。
    return null;
  }
}
