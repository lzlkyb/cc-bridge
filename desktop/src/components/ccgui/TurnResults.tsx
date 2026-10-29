import type { CcMessage } from "../../lib/ccGuiTypes";
import { Icon } from "../ui/icon";
import { toolArgLabel, toolKind } from "./summarize";

/** Report settled tool calls, including failures; command completion does not establish test coverage. */
export function turnResults(messages: CcMessage[], endIndex: number) {
  let start = endIndex;
  while (start >= 0 && messages[start].kind !== "user") start--;
  if (start < 0) return [];
  return messages.slice(start + 1, endIndex + 1).filter((message): message is Extract<CcMessage, { kind: "tool" }> => {
    if (message.kind !== "tool" || message.tool.status === "running") return false;
    return ["edit", "write", "bash"].includes(toolKind(message.tool.name));
  });
}

export function TurnResults({ messages, endIndex }: { messages: CcMessage[]; endIndex: number }) {
  const results = turnResults(messages, endIndex);
  if (!results.length) return null;
  return <details className="cc-turn-results">
    <summary><Icon name={results.some(m => m.tool.status === "error" || m.tool.isError) ? "alertTriangle" : "check"} size={13} />本轮操作 · {results.length} 项<span>查看详情</span></summary>
    <p className="cc-chat-note">依据已完成的工具记录；命令完成不代表验证成功，其他途径产生的改动可能未收录。</p><div>{results.map(({ id, tool }) => <button key={id} type="button" title={typeof tool.input.file_path === "string" ? tool.input.file_path : typeof tool.input.path === "string" ? tool.input.path : undefined} onClick={(event) => {
      const panel = event.currentTarget.closest("[data-cc-panel]");
      const target = panel?.querySelector<HTMLElement>(`[data-cc-tool="${CSS.escape(id)}"]`);
      if (!target) return;
      let parent = target.closest("details");
      while (parent) { parent.open = true; parent = parent.parentElement?.closest("details") ?? null; }
      target.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      target.classList.add("anchor-highlight");
      window.setTimeout(() => target.classList.remove("anchor-highlight"), 2000);
    }}><Icon name={toolKind(tool.name) === "bash" ? "terminal" : "file"} size={14} />
      <span>{toolKind(tool.name) === "bash" ? "执行命令" : "文件操作"}{tool.status === "error" || tool.isError ? "（失败）" : ""} · {toolArgLabel(tool.input) || tool.name}</span>
    </button>)}</div>
  </details>;
}
