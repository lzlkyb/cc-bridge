import { Fragment } from "react";
import type { CcMessage } from "../../lib/ccGuiTypes";
import type { CcView } from "../../lib/ccReducer";
import type { CcMark } from "../../lib/ccMarkdown";
import type { CcTurnStat } from "../../lib/ccTurnStat";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { buildMessageIndex } from "../../lib/ccMessageIndex";
import { isClearCommand } from "../../lib/ccSlash";
import { Icon } from "../ui/icon";
import { ClawdCharacter } from "./ClawdCharacter";
import { ApprovalCard } from "./ApprovalCard";
import { MessageText } from "./MessageText";
import { ClearMark, StopMark } from "./StreamMarks";
import { ThinkingBlock } from "./ThinkingBlock";
import { TodoProgressCard } from "./TodoProgressCard";
import { ExecutionSummary } from "./ExecutionSummary";
import { ToolCard } from "./ToolCard";
import { TurnFooter } from "./TurnFooter";
import { TurnResults } from "./TurnResults";
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
  stops,
  stopState = null,
  companionTarget,
  onRespond,
  onForkMessage,
  onResend,
  startIndex = 0,
  onLoadEarlier,
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
  /**
   * 用户按停的落点（见 `CcView.stops`）。每个元素是一条消息 id，空串 = 按停时
   * 还没有任何消息（标记挂在流开头）。
   *
   * 与 `turns` 一样是旁路数据：挂在某条消息**之后**，不参与 `messages` 的遍历。
   */
  stops: string[];
  stopState?: "stopping" | "unconfirmed" | null;
  companionTarget?: string;
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
  /**
   * 在原地重发最后一条用户消息（不改文本、不另开会话）。
   *
   * 只给最后一条：重发中间那几条没有意义 —— 上下文早就走过去了，重发只会在
   * 会话末尾多插一句孤立的提问。
   */
  onResend: (text: string) => void;
  /**
   * 渲染窗口的起点（全量 `messages` 下标）。0 = 全量渲染。
   *
   * 🔴 只影响**画出来的**消息，不影响任何遍历：`lastUserIdx` 这类判定仍按全量算，
   *    会话内搜索 / 导出 / 分叉也各自遍历 `messages`。窗口缩小不改语义
   *    （见 `lib/ccWindow.ts` 头注）。
   */
  startIndex?: number;
  /** 点顶部「加载更早」：由持有 `scrollRef` 的调用方做滚动锚点补偿。 */
  onLoadEarlier?: () => void;
}) {
  const { copy, isCopied } = useCopyFeedback();
  const start = Math.min(Math.max(0, startIndex), messages.length);
  const visible = start > 0 ? messages.slice(start) : messages;
  // 下标账本（最后一条提问 / 最后一条回复 / 工具分组 / 脚注挂载点）全是纯计算，
  // 在 `lib/ccMessageIndex.ts`：这里只消费，不推导。
  const { lastTodoIdx, lastUserIdx, lastAssistantIdx, turnsByAfterId, stopSet, groups, grouped } =
    buildMessageIndex({ messages, start, turns, stops });
  /** 「重新生成」重发的是最后一条**提问**（与用户气泡的「再问一次」同源）。 */
  const lastUserText = lastUserIdx >= 0 ? (messages[lastUserIdx] as { text: string }).text : "";
  return (
    <>
      {/* 空串的停止点：刚发出去就被停，一条消息都没产出 ⇒ 那个落点在时间轴上
          位于**所有消息之前**，所以挂在开头而不是流尾。
          挂流尾的话，等下一轮回复进来，这条「已停止」会跑到新回复下面 ——
          读起来像是「刚才那一轮（已经成功的那轮）被停了」。
          `start === 0` 才画：窗口化之后，「流开头」已经不在屏幕上，把那条停止线
          顶在窗口第一条消息上方，会读成「这里刚被停」。 */}
      {start === 0 && stopSet.has("") && <StopMark state={stops[stops.length - 1] === "" ? stopState : null} />}
      {start > 0 && (
        <div className="cc-load-earlier">
          <button type="button" onClick={onLoadEarlier} disabled={!onLoadEarlier}>
            <Icon name="arrowUp" size={12} />
            加载更早的 {start} 条
          </button>
          <small>已载入最近 {messages.length - start} 条</small>
        </div>
      )}
      {visible.map((m: CcMessage, vi) => {
        const index = start + vi;
        if (grouped.has(index)) return null;
        const group = groups.get(index);
        if (group) return <ExecutionSummary key={m.id} messages={group} marksByMsg={marksByMsg} />;
        const marks = marksByMsg?.get(m.id);
        const footers = turnsByAfterId.get(m.id);
        // 整个消息渲染体放进 IIFE，只为在它后面补脚注：五个分支各自 `return`
        // 一个节点，逐处改容易漏；包一层就只改边界。
        const node = (() => {
          if (m.kind === "user") {
            return (
              // `data-cc-user`：按轮导航的锚点（`useCcMessageNav` 靠布局找位置，
              // 不从 state 重算下标 —— 搜索高亮、折叠展开都会改变实际位置）。
              // `scroll-mt-2`：跳到某条时别贴着容器顶边，留一点呼吸。
              <div key={m.id} data-cc-user data-cc-msg={m.id} className="flex scroll-mt-2 justify-end">
                <UserMessageBubble
                  text={m.text}
                  images={m.images}
                  marks={marks}
                  onFork={(text) => onForkMessage(index, text)}
                  onResend={index === lastUserIdx ? () => onResend(m.text) : undefined}
                />
              </div>
            );
          }
          if (m.kind === "assistant") {
            return (
              <article key={m.id} className="cc-assistant-message">
                <div className="cc-assistant-heading"><ClawdCharacter staticPose /><span className="sr-only">Claude Code</span>{m.model && <small>{m.model}</small>}</div>
                <div className="cc-assistant-content">
                  {/* 光标只给「本轮最后一条」：历史消息画光标等于说有东西正在写。 */}
                  <MessageText text={m.text} marks={marks} streaming={running && index === messages.length - 1} />
                </div>
                {/*
                  助手侧动作区（P0-4）：常显低对比。
                  此前只有一个 `opacity:0`、hover 才现形的「复制回复」—— 键盘用户靠 Tab
                  摸过去才发现，发现性为零。动作区放在正文**之后**：读屏先念内容，再念按钮。
                  「重新生成」实为把最后一条提问原样再发一次（会话真源在 CLI 进程里，
                  没有「回到第 N 轮」的原语），所以 title 里必须说清新回复接在末尾，
                  文案也不能写成「重新生成这条回复」。
                */}
                <div className="cc-msg-actions">
                  <button
                    type="button"
                    onClick={() => copy(`msg:${m.id}`, m.text)}
                    aria-label="复制全文"
                    aria-live="polite"
                    title="复制这条回复的全文"
                  >
                    <Icon name={isCopied(`msg:${m.id}`) ? "check" : "copy"} size={13} />
                    <span className="cc-msg-action-label">{isCopied(`msg:${m.id}`) ? "已复制" : "复制"}</span>
                  </button>
                  {index === lastAssistantIdx && !running && (
                    <button
                      type="button"
                      className="accent"
                      onClick={() => onResend(lastUserText)}
                      aria-label="重新生成"
                      title="会把最后一条提问原样再发一次，新回复接在末尾（旧回复不会被替换）"
                    >
                      <Icon name="refresh" size={13} />
                      <span className="cc-msg-action-label">重新生成</span>
                    </button>
                  )}
                </div>
              </article>
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
                  <span className="ml-auto text-[11px] tabular-nums">
                    {done} / {items.length}
                  </span>
                </div>
              );
            }
            return <ToolCard key={m.id} tool={m.tool} marks={marks} />;
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
        // `/clear` 的清空线：从消息内容推导，不额外记状态 —— 历史重放时也自动在。
        const cleared = m.kind === "user" && isClearCommand(m.text);
        const stopped = stopSet.has(m.id);
        const message = <div data-cc-message={m.id} className={companionTarget === m.id ? "cc-clawd-target" : undefined}>{node}</div>;
        if (!footers?.length && !cleared && !stopped) return <Fragment key={m.id}>{message}</Fragment>;
        return (
          <Fragment key={m.id}>
            {message}
            {cleared && <ClearMark />}
            {footers?.map((s, i) => (
              <Fragment key={`${m.id}#turn${i}`}><TurnFooter stat={s} />{footers.length === 1 && <TurnResults messages={messages} endIndex={index} />}</Fragment>
            ))}
            {stopped && <StopMark state={stops[stops.length - 1] === m.id ? stopState : null} />}
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
