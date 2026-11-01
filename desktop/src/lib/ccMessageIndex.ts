/**
 * 消息列表的派生索引（纯计算）。
 *
 * 从 `MessageList` 拆出：那个文件里这一段是「一眼看不出在干什么」的下标账本
 * （最后一条用户消息 / 最后一条助手消息 / 工具分组 / 轮次脚注挂载点 / 停止点），
 * 而渲染体本身已经很长。纯下标计算放 `lib/` 还能单测。
 *
 * 🔴 所有下标都是**全量 `messages` 的下标**，不是渲染窗口内的偏移：
 *    `onForkMessage(index)`、`TurnResults endIndex`、搜索定位都按全量走。
 */

import type { CcMessage } from "./ccGuiTypes";
import type { CcTurnStat } from "./ccTurnStat";
import { toolKind } from "../components/ccgui/summarize";

export type CcGroupableTool = Extract<CcMessage, { kind: "tool" }>;

export type CcMessageIndex = {
  /** 最后一次 TodoWrite 的下标（只有它展开成进度卡，历史折叠成一行）。 */
  lastTodoIdx: number;
  /** 最后一条用户消息（「再问一次」只给它）。 */
  lastUserIdx: number;
  /** 最后一条助手消息（「重新生成」只给它）。 */
  lastAssistantIdx: number;
  /** `afterId` → 这一轮的统计。同一 id 可能有多条（某轮一条消息都没产出）。 */
  turnsByAfterId: Map<string, CcTurnStat[]>;
  /** 停止点锚集合（元素是消息 id，空串 = 流开头）。 */
  stopSet: Set<string>;
  /** 分组头下标（全量）→ 该组工具消息。 */
  groups: Map<number, CcGroupableTool[]>;
  /** 被分组收走、不该再单独渲染的下标（全量）。 */
  grouped: Set<number>;
};

export function buildMessageIndex({
  messages,
  start,
  turns,
  stops,
}: {
  messages: CcMessage[];
  /** 渲染窗口起点（全量下标）。0 = 全量渲染。 */
  start: number;
  turns: CcTurnStat[];
  stops: string[];
}): CcMessageIndex {
  let lastTodoIdx = -1;
  let lastUserIdx = -1;
  let lastAssistantIdx = -1;
  messages.forEach((m, i) => {
    if (m.kind === "tool" && toolKind(m.tool.name) === "todo") lastTodoIdx = i;
    if (m.kind === "user") lastUserIdx = i;
    if (m.kind === "assistant") lastAssistantIdx = i;
  });

  const turnsByAfterId = new Map<string, CcTurnStat[]>();
  for (const t of turns) {
    const arr = turnsByAfterId.get(t.afterId);
    if (arr) arr.push(t);
    else turnsByAfterId.set(t.afterId, [t]);
  }
  // 每条消息都 `includes` 一遍数组没必要 —— 停止点通常只有几个。
  const stopSet = new Set(stops);

  /**
   * 连续且「成功、非 todo、不带轮次脚注、不是停止点」的工具消息并成一组，
   * 由 `ExecutionSummary` 折成「改了 3 个文件」这样一行。
   *
   * 按**窗口内**的消息算：分组头若落在窗口外，那几条工具行就各自成行 ——
   * 只有「加载更早」的边界会碰到一次，比把窗口起点往前挪（会打乱分页）简单。
   */
  const visible = start > 0 ? messages.slice(start) : messages;
  const groups = new Map<number, CcGroupableTool[]>();
  const grouped = new Set<number>();
  for (let i = 0; i < visible.length; i++) {
    const group: CcGroupableTool[] = [];
    let end = i;
    while (end < visible.length) {
      const item = visible[end];
      if (
        item.kind !== "tool" ||
        item.tool.status !== "ok" ||
        toolKind(item.tool.name) === "todo" ||
        turnsByAfterId.has(item.id) ||
        stopSet.has(item.id)
      ) break;
      group.push(item);
      end++;
    }
    if (group.length > 0) {
      groups.set(start + i, group);
      for (let j = i + 1; j < end; j++) grouped.add(start + j);
      i = end - 1;
    }
  }

  return { lastTodoIdx, lastUserIdx, lastAssistantIdx, turnsByAfterId, stopSet, groups, grouped };
}
