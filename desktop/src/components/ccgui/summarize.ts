/**
 * 工具卡的展示层派生逻辑（纯函数）。
 *
 * 🔴 分流用**精确名字**，不用子串匹配。desktop-cc-gui 用 `name.includes("write")`
 *    判断编辑类工具，导致 `write_files` 命中 Edit 分支、而它的入参是
 *    `files: [{path, content}]` 数组，取不到顶层的 `path`/`content`，最后静默退化成
 *    一团 JSON 原文。名字表 + 形状校验是更稳的写法。
 */

import { plainOccurrences } from "../../lib/ccHighlight";
import { markdownLeaves } from "../../lib/ccMarkdown";
import type { ChatVerbosity } from "../../lib/chatVerbosity";
import type { CcMessage } from "../../lib/ccGuiTypes";

export type ToolKind = "edit" | "write" | "bash" | "read" | "todo" | "other";

const EXACT: Record<string, ToolKind> = {
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Bash: "bash",
  BashOutput: "bash",
  Read: "read",
  NotebookRead: "read",
  TodoWrite: "todo",
};

/** MCP 工具名形如 `mcp__cc-bridge__write_files`，取最后一段再查表。 */
export function toolKind(name: string): ToolKind {
  const tail = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return EXACT[name] ?? EXACT[tail] ?? "other";
}

/**
 * 工具行的**默认展开态**，由详略档位决定（`lib/chatVerbosity.ts`）。
 *
 * 纯函数放在这里而不是 `ToolCard` 里：展开策略是这个文件既有的职责
 * （`toolKind` / `editPair` / `clampToolText` 都在回答「这条工具怎么展示」），
 * 而且能直接单测三档 × 六种工具，不必挂渲染。
 *
 * - `c` 精简：一律收着，只留那一行摘要。
 * - `v` 详细：有内容就摊开（Read 的入参 JSON、MCP 工具的入参都在这一档才看得到）。
 * - `n` 标准：改动前的行为 —— 编辑类摊开（diff 就是这次调用的意义）、
 *   Bash 有输出才摊开、其余收着。
 */
export function toolDefaultOpen(
  verbosity: ChatVerbosity,
  kind: ToolKind,
  hasBody: boolean,
  hasResult: boolean,
): boolean {
  if (verbosity === "c") return false;
  if (verbosity === "v") return hasBody;
  return kind === "edit" || kind === "write" || (kind === "bash" && hasResult);
}

/** 卡片头部那行参数摘要：路径只留后两段，避免绝对路径把行撑爆。 */
export function toolArgLabel(input: Record<string, unknown>): string {
  const raw = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "";
  if (raw) {
    const parts = raw.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join("/");
  }
  if (typeof input.command === "string") return input.command;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.url === "string") return input.url;
  return "";
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** TodoWrite 的一条待办。`status` 取值与协议一致。 */
export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed" };

/**
 * TodoWrite 的入参解析。TodoWrite 每次调用都发**全量列表**（协议事实，没有增量）。
 * 形状不对（老版本 CLI / 同名 MCP 工具）返回 null —— 调用方回落到普通工具行，
 * 不猜。
 */
export function todoItems(input: Record<string, unknown>): TodoItem[] | null {
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const out: TodoItem[] = [];
  for (const t of todos) {
    const row = t as Record<string, unknown> | null;
    const content = asString(row?.content);
    if (!content) continue;
    const status = row?.status;
    out.push({
      content,
      status: status === "in_progress" || status === "completed" ? status : "pending",
    });
  }
  return out.length > 0 ? out : null;
}

/* ── 会话内搜索的「可见文本」口径（设计稿《对话页-会话内搜索》）──────────
 *
 * 一条消息 → 若干段，每段恰好对应渲染层的一个文本叶子（`CcMark.seg` 就是段下标）。
 * 🔴 段的取法必须与渲染处**逐字一致**：思考标题的 60 字截断、工具行的
 *    参数摘要、markdown 叶子切分——渲染改一处，这里必须跟着改，
 *    否则出现「计数说命中、界面上找不到」的分裂。 */

/** 首个非空行。indexOf + slice 只扫到第一个换行（流式期间每次渲染都调，别 split 全文）。 */
export function firstNonEmptyLine(text: string): string {
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end).trim();
    if (line) return line;
    if (nl === -1) return "";
    start = nl + 1;
  }
  return "";
}

/** 思考折叠行显示的标题（与 `ThinkingBlock` 的截断口径逐字一致）。 */
export function thinkingTitle(text: string): string {
  const first = firstNonEmptyLine(text);
  const clipped = first.length > 60 ? `${first.slice(0, 60)}…` : first;
  return clipped || "（空）";
}

/** 一条消息的可见文本段。 */
export function convSegments(m: CcMessage): string[] {
  switch (m.kind) {
    case "user":
    case "assistant":
      // 两类气泡都走 MessageText（markdown 渲染），叶子切分同源。
      return markdownLeaves(m.text);
    case "thinking":
      return [thinkingTitle(m.text)];
    case "tool": {
      const label = toolArgLabel(m.tool.input);
      return label ? [label] : [];
    }
    default:
      return []; // 审批 / 已裁决行不入搜索口径
  }
}

/** 一处命中：`msgId` + 段下标 + 段内字符区间。 */
export type ConvHit = { msgId: string; seg: number; start: number; end: number };

/** 按文档顺序收集全部命中（大小写不敏感，foldSafe 见 `plainOccurrences`）。 */
export function buildConvHits(messages: CcMessage[], query: string): ConvHit[] {
  const q = query.trim();
  if (!q) return [];
  const out: ConvHit[] = [];
  for (const m of messages) {
    const segs = convSegments(m);
    for (let s = 0; s < segs.length; s++) {
      for (const [start, end] of plainOccurrences(segs[s], q)) {
        out.push({ msgId: m.id, seg: s, start, end });
      }
    }
  }
  return out;
}

/** Edit 的 diff 源：同时兼容 `old_string/new_string` 与 `edits:[{old_string,new_string}]`。
 *
 * MultiEdit 的多处修改**按顺序拼接**成一对大文本：段间用「⋯」行分隔 —— 分隔行在
 * 旧/新两侧完全相同，diff 里会落成上下文行，正好当作两处修改之间的视觉分界。
 * 只取第一处是老缺陷：改 10 处只看到第 1 处，± 统计也只数了第 1 处。 */
export function editPair(input: Record<string, unknown>): { oldText: string; newText: string } | null {
  const oldText = asString(input.old_string);
  const newText = asString(input.new_string);
  if (oldText || newText) return { oldText, newText };
  const edits = input.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const pick = (key: string) =>
      edits.map((e) => asString((e as Record<string, unknown> | null)?.[key])).join("\n⋯\n");
    return { oldText: pick("old_string"), newText: pick("new_string") };
  }
  return null;
}

/** MultiEdit 一共几处修改（其它编辑工具恒为 1）。 */
export function editCount(input: Record<string, unknown>): number {
  const edits = input.edits;
  if (!Array.isArray(edits) || edits.length === 0) return 1;
  return edits.length;
}

/** 工具输出 / 入参 JSON 的展示截断上限。
 *
 * 与历史入库侧的 16k 截断（`cc_history/parse.rs`）同口径：那道闸只在入库时生效，
 * **实时**链路没有 —— 前端再不截，一条几 MB 的命令输出就是整串进 DOM 做布局。 */
export const TOOL_TEXT_LIMIT = 16_000;

/** 截到展示上限。`clipped = true` 时调用方要给「已截断」提示；复制仍应复制全文。 */
export function clampToolText(text: string): { text: string; clipped: boolean } {
  if (text.length <= TOOL_TEXT_LIMIT) return { text, clipped: false };
  return { text: text.slice(0, TOOL_TEXT_LIMIT), clipped: true };
}

/**
 * 已落定卡片的落款。
 *
 * 提问说「回答 / 跳过」，审批说「允许 / 拒绝」—— 两件事用一个词会让人分不清
 * 自己刚才是放行了一条命令，还是回答了一个问题。落款留在历史里，事后回看
 * 只能靠它判断当时发生了什么。`auto` 再补一层：规则放行的和用户亲手点的
 * 必须能分清，否则「谁放的行」在审计里说不清。
 */
export function verdictLabel(toolName: string, verdict: "allow" | "deny", auto?: boolean): string {
  const ask = toolName === "AskUserQuestion";
  if (auto && verdict === "allow") return "已按规则自动放行";
  if (verdict === "allow") return ask ? "已回答" : "已允许一次";
  return ask ? "已跳过" : "已拒绝";
}
