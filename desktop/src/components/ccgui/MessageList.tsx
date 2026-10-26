import { Fragment } from "react";
import type { CcMessage } from "../../lib/ccGuiTypes";
import type { CcView } from "../../lib/ccReducer";
import type { CcMark } from "../../lib/ccMarkdown";
import type { CcTurnStat } from "../../lib/ccTurnStat";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { Icon } from "../ui/icon";
import { ApprovalCard } from "./ApprovalCard";
import { MessageText } from "./MessageText";
import { ThinkingBlock } from "./ThinkingBlock";
import { TodoProgressCard } from "./TodoProgressCard";
import { ToolCard } from "./ToolCard";
import { TurnFooter } from "./TurnFooter";
import { UserMessageBubble } from "./UserMessageBubble";
import { todoItems, toolKind, verdictLabel } from "./summarize";

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
  marksByMsg,
  turns,
  onRespond,
  onForkMessage,
}: {
  messages: CcMessage[];
  resolved: CcView["resolved"];
  running: boolean;
  /** 会话内搜索的命中标注（msgId → 该消息内的标注列表）。null/缺消息 = 无高亮。 */
  marksByMsg?: Map<string, CcMark[]> | null;
  /**
   * 每轮的用量与速度。按 `afterId` 挂到那一轮最后一条消息之后。
   *
   * 刻意不塞进 `messages`：会话内搜索、导出、分叉切点都在遍历消息数组，多一种
   * 「统计行」会让它们各自长出一个排除分支，而它们本不该知道这件事。
   */
  turns: CcTurnStat[];
  onRespond: (
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
    answers?: Record<string, string[]>,
  ) => void;
  /**
   * 在这条用户消息处「编辑重发 / 分叉」（3-3）。参数是**消息下标**与最终文本：
   * 下标决定摘要从哪里截断，文本是用户可能要改的那句话。
   */
  onForkMessage: (index: number, text: string) => void;
}) {
  const { copy, isCopied } = useCopyFeedback();
  // TodoWrite 每次调用都发全量列表：只有**最新一张**展开成进度卡，历史更新
  // 折叠成一行（设计稿 B 期）。不折叠的话一次多步重构就是七八张重复卡刷屏。
  let lastTodoIdx = -1;
  messages.forEach((m, i) => {
    if (m.kind === "tool" && toolKind(m.tool.name) === "todo") lastTodoIdx = i;
  });
  // 一轮的脚注跟在「那一轮最后一条消息」后面。同一 id 可能有多条（例如某轮
  // 一条消息都没产出、两轮都落在同一条上），所以是数组不是单值。
  const turnsByAfterId = new Map<string, CcTurnStat[]>();
  for (const t of turns) {
    const arr = turnsByAfterId.get(t.afterId);
    if (arr) arr.push(t);
    else turnsByAfterId.set(t.afterId, [t]);
  }

  return (
    <>
      {messages.map((m: CcMessage, index) => {
        const marks = marksByMsg?.get(m.id);
        const footers = turnsByAfterId.get(m.id);
        // 整个消息渲染体放进 IIFE，只为在它后面补脚注：五个分支各自 `return`
        // 一个节点，逐处改容易漏；包一层就只改边界。
        const node = (() => {
          if (m.kind === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <UserMessageBubble
                  text={m.text}
                  images={m.images}
                  marks={marks}
                  onFork={(text) => onForkMessage(index, text)}
                />
              </div>
            );
          }
          if (m.kind === "assistant") {
            return (
              <div key={m.id} className="group/msg relative flex gap-2">
                <span className="mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-primary/10 text-primary">
                  <Icon name="sparkles" size={11} />
                </span>
                <div className="min-w-0 flex-1 pt-[1px]">
                  <MessageText text={m.text} marks={marks} />
                </div>
                {/* 正文悬浮复制：工具卡 / 思考全文早有了，正文是补齐项（设计稿 C 期）。
                    focus-visible 常显 —— 键盘用户没有 hover。 */}
                <button
                  type="button"
                  onClick={() => copy(`msg:${m.id}`, m.text)}
                  title={isCopied(`msg:${m.id}`) ? "已复制" : "复制全文"}
                  aria-label="复制全文"
                  aria-live="polite"
                  className="absolute -top-2 right-0 flex h-[22px] items-center gap-1 rounded-md border border-border bg-card/95 px-1.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/msg:opacity-100"
                >
                  <Icon name={isCopied(`msg:${m.id}`) ? "check" : "copy"} size={10} />
                  {isCopied(`msg:${m.id}`) ? "已复制" : "复制"}
                </button>
              </div>
            );
          }
          if (m.kind === "thinking") {
            return <ThinkingBlock key={m.id} text={m.text} running={running} titleMarks={marks} />;
          }
          if (m.kind === "tool") {
            if (toolKind(m.tool.name) === "todo" && todoItems(m.tool.input)) {
              if (index === lastTodoIdx) return <TodoProgressCard key={m.id} tool={m.tool} />;
              const items = todoItems(m.tool.input)!;
              const done = items.filter((i) => i.status === "completed").length;
              return (
                <div
                  key={m.id}
                  data-cc-tool={m.tool.id}
                  className="flex h-6 items-center gap-2 px-2 text-[11.5px] text-muted-foreground"
                >
                  <Icon name="check" size={10} className="text-primary/80" />
                  任务计划 · 更新
                  <span className="ml-auto text-[10.5px] tabular-nums">
                    {done} / {items.length}
                  </span>
                </div>
              );
            }
            return <ToolCard key={m.id} tool={m.tool} labelMarks={marks} />;
          }

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
        })();
        if (!footers?.length) return <Fragment key={m.id}>{node}</Fragment>;
        return (
          <Fragment key={m.id}>
            {node}
            {footers.map((s, i) => (
              <TurnFooter key={`${m.id}#turn${i}`} stat={s} />
            ))}
          </Fragment>
        );
      })}
      {/* `afterId` 是空串 = 这一轮一条消息都没产出（认证失败 / 只报错的轮次），
          没有可依附的消息，统一挂在流末尾。不处理的话这一轮的消耗会彻底看不见，
          而那正是最该看的时候。 */}
      {(turnsByAfterId.get("") ?? []).map((s, i) => (
        <TurnFooter key={`turn-tail-${i}`} stat={s} />
      ))}
    </>
  );
}
