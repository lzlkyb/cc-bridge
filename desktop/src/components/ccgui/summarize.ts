/**
 * 工具卡的展示层派生逻辑（纯函数）。
 *
 * 🔴 分流用**精确名字**，不用子串匹配。desktop-cc-gui 用 `name.includes("write")`
 *    判断编辑类工具，导致 `write_files` 命中 Edit 分支、而它的入参是
 *    `files: [{path, content}]` 数组，取不到顶层的 `path`/`content`，最后静默退化成
 *    一团 JSON 原文。名字表 + 形状校验是更稳的写法。
 */

export type ToolKind = "edit" | "write" | "bash" | "read" | "other";

const EXACT: Record<string, ToolKind> = {
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Bash: "bash",
  BashOutput: "bash",
  Read: "read",
  NotebookRead: "read",
};

/** MCP 工具名形如 `mcp__cc-bridge__write_files`，取最后一段再查表。 */
export function toolKind(name: string): ToolKind {
  const tail = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return EXACT[name] ?? EXACT[tail] ?? "other";
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
