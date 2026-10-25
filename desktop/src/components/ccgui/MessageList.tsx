import type { CcMessage } from "../../lib/ccGuiTypes";
import type { CcView } from "../../lib/ccReducer";
import { Icon } from "../ui/icon";
import { ApprovalCard } from "./ApprovalCard";
import { MessageText } from "./MessageText";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./ToolCard";
import { verdictLabel } from "./summarize";

/**
 * 跳过提问时告诉模型的话。
 *
 * 不能只回一个空 deny —— `Verdict::deny` 的默认文案是「用户拒绝了这次调用，
 * 请换一种做法」，对提问来说会让模型以为选项被否掉，转头再来问一次。
 * 说清「跳过」它才会自己决定。
 */
const SKIP_ASK =
  "用户跳过了这个问题（没有选择任何选项）。请按你认为最合理的方式继续，不要重复提问。";

/**
 * 对话流：一条 `CcMessage` → 一个节点。
 *
 * 2026-10-24 从 `CcGuiTab` 拆出：那一个 `.map` 里分了五种形态（用户 / 助手 /
 * 思考 / 工具 / 审批），留着把宿主组件推过 300 行门禁。只搬渲染、不搬状态 ——
 * 裁决转发由调用方的 `onRespond` 出去，组件本身无副作用。
 */
export function MessageList({
  messages,
  resolved,
  running,
  onRespond,
}: {
  messages: CcMessage[];
  resolved: CcView["resolved"];
  running: boolean;
  onRespond: (
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
    answers?: Record<string, string[]>,
  ) => void;
}) {
  return (
    <>
      {messages.map((m: CcMessage) => {
        if (m.kind === "user") {
          return (
            <div key={m.id} className="flex justify-end">
              {/* data-cc-bubble：玻璃阅读面上 primary/.12 会混成脏紫，改同色系高一档 */}
              <div
                data-cc-bubble
                className="max-w-[86%] rounded-xl rounded-br-sm border border-border bg-muted/60 px-3 py-1.5"
              >
                <MessageText text={m.text} />
              </div>
            </div>
          );
        }
        if (m.kind === "assistant") {
          return (
            <div key={m.id} className="flex gap-2">
              <span className="mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-primary/10 text-primary">
                <Icon name="sparkles" size={11} />
              </span>
              <div className="min-w-0 flex-1 pt-[1px]">
                <MessageText text={m.text} />
              </div>
            </div>
          );
        }
        if (m.kind === "thinking") {
          return <ThinkingBlock key={m.id} text={m.text} running={running} />;
        }
        if (m.kind === "tool") return <ToolCard key={m.id} tool={m.tool} />;

        const verdict = resolved[m.id];
        if (verdict) {
          return (
            <div
              key={m.id}
              data-cc-inset
              className="flex items-center gap-1.5 rounded-[10px] border border-border bg-muted/40 px-3 py-[6px] text-[11px] text-muted-foreground"
            >
              <Icon name={verdict.decision === "allow" ? "check" : "close"} size={11} />
              <span className="font-mono">{m.toolName}</span>
              {verdictLabel(m.toolName, verdict.decision, verdict.auto)}
            </div>
          );
        }
        return (
          <ApprovalCard
            key={m.id}
            approval={m}
            onAllow={() => onRespond(m.id, "allow")}
            onDeny={() =>
              onRespond(
                m.id,
                "deny",
                m.toolName === "AskUserQuestion" ? SKIP_ASK : undefined,
              )
            }
            onAnswer={(answers) => onRespond(m.id, "allow", undefined, answers)}
          />
        );
      })}
    </>
  );
}
