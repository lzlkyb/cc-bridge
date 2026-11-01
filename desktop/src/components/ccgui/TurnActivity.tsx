import type { CcMessage } from "../../lib/ccGuiTypes";

/**
 * 本轮「状态文案」与「停滞时长」两个纯函数。
 *
 * 曾经这里还有一个 `<TurnActivity>` 组件，**从未被任何地方渲染**（只有纯函数被
 * `ConversationStream` 用），而且它读的 `at` 当时恒为空串 ⇒ 组件里那句「暂未收到
 * 新进展」永远不可能出现。2026-11 审查后删掉组件，把停滞信息并进已有的两个出口：
 * 「回到底部」浮条（`StreamHud`）与 Clawd 的状态行（`ClawdWorkspace`）。
 * 理由：浮层不占布局是项目红线，为了一个提示再挂一个常驻组件不值得。
 */

/** 超过这么多秒没有新记录，才值得安慰用户一句「没卡，只是慢」。 */
export const STALE_SEC = 30;

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

/**
 * 距离本轮「最近一条记录」过了多少秒；`null` = 无从判断。
 *
 * 🔴 `null` 是常态而非异常：历史流水没有到达时刻（`replay` 不传 `at`），
 *    刚发出、后端还没回第一个事件时也没有。**没有参照就不要编一个**——
 *    「0 秒前」比不显示更糟。
 *
 * 从后往前找第一条**带有效时间戳**的消息：流式期间正文会一直刷新自己的 `at`，
 * 所以「最近一条」就是「最后一个有动静的时刻」。
 */
export function lastRecordAge(messages: CcMessage[], startIndex: number | undefined, now: number): number | null {
  let start = startIndex;
  if (start === undefined) {
    let lastUser = -1;
    messages.forEach((message, index) => { if (message.kind === "user") lastUser = index; });
    start = Math.max(0, lastUser);
  }
  for (let i = messages.length - 1; i >= start; i -= 1) {
    const m = messages[i];
    if (!("at" in m) || !m.at) continue;
    const ts = Date.parse(m.at);
    if (Number.isFinite(ts)) return Math.max(0, Math.floor((now - ts) / 1000));
  }
  return null;
}

/**
 * 浮条 / 状态行要显示的文案：基础状态 + （超过阈值时）停滞时长。
 *
 * 分开成一个函数是因为两个出口（浮条、Clawd 状态行）必须说同一句话 ——
 * 各写一遍必然长出两套口径。
 */
export function activityLine(
  messages: CcMessage[],
  running: boolean,
  sending: boolean,
  startIndex: number | undefined,
  resolved: Record<string, unknown>,
  now: number,
): string | null {
  const base = turnActivity(messages, running, sending, startIndex, resolved);
  const age = running ? lastRecordAge(messages, startIndex, now) : null;
  if (age === null || age < STALE_SEC) return base;
  // 基础文案为 null 说明「此刻正在干一件明确的事」（工具在跑 / 等你批准），
  // 那时浮条本来只剩「回到底部」—— 恰好最需要一个「还活着」的参照。
  return base ? `${base} · ${age} 秒无新记录` : `${age} 秒无新记录`;
}
