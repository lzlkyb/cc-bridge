import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { CcMessage } from "../../lib/ccGuiTypes";
import type { CcMark } from "../../lib/ccMarkdown";
import { useChatVerbosity } from "../../lib/chatVerbosity";
import { ToolCard } from "./ToolCard";

type ToolMessage = Extract<CcMessage, { kind: "tool" }>;

/**
 * 一轮里连续的工具调用收成一组（`<details>`）。
 *
 * 🔴 展开态必须**完全受控**。此前是 `open={matches || verbosity === "v" ? true : undefined}`
 *    —— 搜索命中时 `open=true`、搜索一关变 `undefined`，React 会把 `open` 属性整个
 *    摘掉 ⇒ 用户此刻正打开着的分组被强制收起；反过来用户在「详细」档手动收起的
 *    分组，下一次 re-render 又不记得他的选择。
 *
 * 现在的语义（与 `ToolCard` 的 `reveal` 是同一套「派生展开」）：
 * - 用户手动开合是**主状态**；
 * - 搜索命中 / 「详细」档只做**强制展开**，且用户手动收起后就尊重他，直到
 *   强制条件消失（命中清空 / 切出详细档）再恢复。
 */
export function ExecutionSummary({ messages, marksByMsg }: { messages: ToolMessage[]; marksByMsg?: Map<string, CcMark[]> | null }) {
  const verbosity = useChatVerbosity();
  const matches = messages.some((message) => marksByMsg?.has(message.id));
  const forced = matches || verbosity === "v";
  const [open, setOpen] = useState(() => verbosity === "v");
  /** 用户亲手收起过 ⇒ 强制展开让位给他（否则搜索期间点收起像按钮坏了）。 */
  const [manuallyClosed, setManuallyClosed] = useState(false);

  // 🔴 复位必须挂在 `forced` 的**上升沿**，不是下降沿。
  //
  // 曾经写的是 `if (!forced) setManuallyClosed(false)`（「强制条件消失就复位」），
  // 而它只在 `forced` 由真变假那一刻跑一次 —— 典型路径是：搜索关着、用户手动收起
  // 分组（`manuallyClosed = true`，`forced` 一直是假，effect 不跑），下一次搜索命中
  // 让 `forced` 变真时，条件 `!forced` 不成立 ⇒ 永远不复位 ⇒ **命中撑不开分组**
  // （与上面「强制条件消失再恢复」正好相反，实测复现过）。
  //
  // 上升沿复位的语义不变：`forced` 保持为真时 effect 不重跑，用户在这一轮里
  // 手动收起仍然被尊重；等到命中清空 / 切出详细档后再次命中，才会重新撑开。
  useEffect(() => {
    if (forced) setManuallyClosed(false);
  }, [forced]);

  // 切档位 = 用户明确要求换一种默认，此时连「手动收起」也一并重置。
  const prevVerbosity = useRef(verbosity);
  useEffect(() => {
    if (prevVerbosity.current === verbosity) return;
    prevVerbosity.current = verbosity;
    setOpen(verbosity === "v");
    setManuallyClosed(false);
  }, [verbosity]);

  const revealed = manuallyClosed ? open : open || forced;
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    const next = e.currentTarget.open;
    setOpen(next);
    setManuallyClosed(!next);
  };

  return (
    <details className="cc-execution-summary" open={revealed} onToggle={onToggle}>
      <summary>工具过程 · {messages.length} 项</summary>
      <div>
        {messages.map((message) => (
          <ToolCard key={message.id} tool={message.tool} marks={marksByMsg?.get(message.id)} />
        ))}
      </div>
    </details>
  );
}
