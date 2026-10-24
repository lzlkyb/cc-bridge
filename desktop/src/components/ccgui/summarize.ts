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

/** Edit 的 diff 源：同时兼容 `old_string/new_string` 与 `edits:[{old_string,new_string}]`。 */
export function editPair(input: Record<string, unknown>): { oldText: string; newText: string } | null {
  const oldText = asString(input.old_string);
  const newText = asString(input.new_string);
  if (oldText || newText) return { oldText, newText };
  const edits = input.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const first = edits[0] as Record<string, unknown>;
    return { oldText: asString(first?.old_string), newText: asString(first?.new_string) };
  }
  return null;
}

/**
 * 已落定卡片的落款。
 *
 * 提问说「回答 / 跳过」，审批说「允许 / 拒绝」—— 两件事用一个词会让人分不清
 * 自己刚才是放行了一条命令，还是回答了一个问题。落款留在历史里，事后回看
 * 只能靠它判断当时发生了什么。
 */
export function verdictLabel(toolName: string, verdict: "allow" | "deny"): string {
  const ask = toolName === "AskUserQuestion";
  if (verdict === "allow") return ask ? "已回答" : "已允许一次";
  return ask ? "已跳过" : "已拒绝";
}
