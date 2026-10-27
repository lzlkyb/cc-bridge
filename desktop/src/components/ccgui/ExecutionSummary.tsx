import type { CcMessage } from "../../lib/ccGuiTypes";
import type { CcMark } from "../../lib/ccMarkdown";
import { useChatVerbosity } from "../../lib/chatVerbosity";
import { ToolCard } from "./ToolCard";

type ToolMessage = Extract<CcMessage, { kind: "tool" }>;
export function ExecutionSummary({ messages, marksByMsg }: { messages: ToolMessage[]; marksByMsg?: Map<string, CcMark[]> | null }) {
  const verbosity = useChatVerbosity();
  const matches = messages.some((message) => marksByMsg?.has(message.id));
  return <details className="cc-execution-summary" open={matches || verbosity === "v" ? true : undefined}>
    <summary>已完成 {messages.length} 项操作 · 查看执行过程</summary>
    <div>{messages.map((message) => <ToolCard key={message.id} tool={message.tool} marks={marksByMsg?.get(message.id)} />)}</div>
  </details>;
}
