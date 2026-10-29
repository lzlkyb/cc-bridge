import { useEffect, useState } from "react";
import type { CcMessage } from "../../lib/ccGuiTypes";
import { Icon } from "../ui/icon";

/** Only show a waiting state until this turn provides real content or a decision. */
export function turnActivity(messages: CcMessage[], running: boolean, sending: boolean, startIndex?: number, resolved: Record<string, unknown> = {}): string | null {
  if (!running && !sending) return null;
  let lastUser = -1;
  messages.forEach((message, index) => { if (message.kind === "user") lastUser = index; });
  const start = startIndex ?? Math.max(0, lastUser);
  const turn = messages.slice(start);
  // Before the backend records the new user message, old replies belong to the preceding turn.
  if (sending && !turn.some(message => message.kind === "user")) return "正在发送消息";
  const last = turn[turn.length - 1];
  if (last?.kind === "assistant") return "本轮进行中";
  if (last?.kind === "thinking") return null;
  if (last?.kind === "tool" && last.tool.status === "running") return null;
  if (last?.kind === "approval" && !resolved[last.id]) return null;
  return sending ? "正在发送消息" : "等待响应";
}

export function TurnActivity({ messages, running, sending, startIndex, resolved, retrying, startedAt }: { messages: CcMessage[]; running: boolean; sending: boolean; startIndex?: number; resolved: Record<string, unknown>; retrying: boolean; startedAt: number | null }) {
  const label = retrying ? null : turnActivity(messages, running, sending, startIndex, resolved);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!label || startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [label, startedAt]);
  if (!label) return null;
  return <div className="cc-turn-activity">
    <Icon name="spinner" size={15} className="cc-turn-activity-spinner" />
    <span role="status" aria-live="polite">{label}</span>
    {startedAt !== null && <span aria-hidden="true">· 本轮 {Math.max(0, Math.floor((now - startedAt) / 1000))} 秒</span>}
  </div>;
}
