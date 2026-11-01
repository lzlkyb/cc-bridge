/**
 * 读屏播报：把「这一轮在发生什么」压成几句话。
 *
 * 🔴 只播四条 —— 开始 / 阶段 / 完成 / 失败。刻意**不复述正文**：转录区本身是
 *    `role="log"`，读屏用户会自己按段落读；再复述一遍等于每句话念两次。
 *    也不念 token、耗时、每一次重试（那是看的人的事，不是听的人的事）。
 *
 * 为什么要有独立的播报区，而不是只给转录区挂 `aria-live`：流式是**改写已有节点**，
 * 逐 token 都会触发变化事件。转录区靠 `aria-busy` 把播报压到轮次结束，代价是
 * 结束时可能一口气念完整轮正文；播报区只说一句摘要，两者互补。
 *
 * 本文件只做纯计算（可单测）；节流所需的时钟与状态搬运在 `hooks/useAnnouncer.ts`。
 */

import type { CcToolCall } from "./ccGuiTypes";
import type { CcView } from "./ccReducer";
import { toolArgLabel, toolKind } from "../components/ccgui/summarize";

export type AnnounceLevel = "polite" | "assertive";

export type Announcement = {
  text: string;
  level: AnnounceLevel;
  /** 递增序号：同一句文本连续出现时，渲染层靠它换 key 让节点重建，读屏才会再念一遍。 */
  seq: number;
};

export type AnnounceState = {
  /** 上一轮的运行态（用来识别翻转，翻转只播一次）。 */
  running: boolean;
  /** 已就「开始执行」播过的工具 id。 */
  seenTools: string[];
  /** 已就「失败」播过的工具 id。 */
  seenErrors: string[];
  /** 上一次播报的时刻（节流用）。 */
  at: number;
  /** 上一次看到的待批准数（只在**增加**时播，退出再进不重复）。 */
  pending: number;
  seq: number;
};

/**
 * 阶段播报的最小间隔。
 *
 * 一次重构三十次 Edit，逐条念「正在修改」等于把界面变成收音机 —— 人只需要知道
 * 「它在动、在改文件」，不需要知道改了三十次。
 */
export const PHASE_MIN_GAP_MS = 1200;

export function initialAnnounceState(running: boolean): AnnounceState {
  // 挂载时已经在跑的会话不补一句「开始回复」——那句话是为「我按了发送」而说的。
  return { running, seenTools: [], seenErrors: [], at: 0, pending: 0, seq: 0 };
}

/** 这一轮（最后一条用户消息之后）发起了多少次工具调用。 */
export function turnToolCount(view: CcView): number {
  let start = 0;
  for (let i = view.messages.length - 1; i >= 0; i--) {
    if (view.messages[i].kind === "user") {
      start = i + 1;
      break;
    }
  }
  let n = 0;
  for (let i = start; i < view.messages.length; i++) {
    if (view.messages[i].kind === "tool") n += 1;
  }
  return n;
}

/** 阶段文案：用「动作 + 目标」说，不用工具英文名（听的人不需要记 26 个工具名）。 */
export function phaseText(tool: CcToolCall): string {
  const arg = toolArgLabel(tool.input);
  const tail = arg ? ` ${arg}` : "";
  switch (toolKind(tool.name)) {
    case "edit":
      return `正在修改${tail}`;
    case "write":
      return `正在写入${tail}`;
    case "bash":
      return `正在执行命令${tail}`;
    case "read":
      return `正在读取${tail}`;
    case "todo":
      // 任务列表更新是内部的记账动作，没有用户视角的意义。
      return "";
    default:
      return `正在调用 ${tool.name}${tail}`;
  }
}

function emit(
  state: AnnounceState,
  text: string,
  level: AnnounceLevel,
  now: number,
): { state: AnnounceState; say: Announcement } {
  const seq = state.seq + 1;
  return { state: { ...state, at: now, seq }, say: { text, level, seq } };
}

/**
 * 给一次状态变化算出「该不该说、说什么」。
 *
 * 调用方可以在任意多的依赖变化上调用它：同一份状态重复调用不会再产出播报
 * （翻转与 id 去重都记在 `prev` 里）。
 */
export function nextAnnouncement(
  prev: AnnounceState,
  view: CcView,
  pending: number,
  now: number,
): { state: AnnounceState; say: Announcement | null } {
  // 1) 失败最优先，也是唯一用 assertive 的：它会中断一轮，值得打断当前朗读。
  //    `canceled` 排除掉用户自己按停的那些 —— 那不是失败（见 CcToolCall.canceled）。
  const failed = view.messages.find(
    (m) =>
      m.kind === "tool" &&
      m.tool.isError === true &&
      m.tool.canceled !== true &&
      !prev.seenErrors.includes(m.tool.id),
  );
  if (failed && failed.kind === "tool") {
    const state = { ...prev, running: view.running, seenErrors: [...prev.seenErrors, failed.tool.id] };
    return emit(state, `${failed.tool.name} 执行失败`, "assertive", now);
  }

  // 2) 轮次翻转：开始 / 完成各一次。
  if (view.running && !prev.running) {
    // 新一轮：清掉上一轮的 id 账本（否则同一个工具 id 复用时会漏播）。
    const state: AnnounceState = { ...prev, running: true, seenTools: [], seenErrors: [], pending };
    return emit(state, "Claude 开始回复", "polite", now);
  }
  if (!view.running && prev.running) {
    const n = turnToolCount(view);
    const state: AnnounceState = { ...prev, running: false, pending };
    return emit(state, n > 0 ? `回复完成，本轮 ${n} 个工具调用` : "回复完成", "polite", now);
  }

  // 3) 空闲：回看历史、加载更早、切会话都不该出声。
  if (!view.running) {
    return { state: prev.pending === pending ? prev : { ...prev, pending }, say: null };
  }

  // 4) 待批准：只在**新增**时播。这是唯一「现在轮到你」的信号，优先级高于阶段。
  if (pending > 0 && pending > prev.pending) {
    const ask = view.messages.find((m) => m.kind === "approval");
    const what = ask && ask.kind === "approval"
      ? [ask.toolName, toolArgLabel(ask.input)].filter(Boolean).join(" ")
      : "";
    const state: AnnounceState = { ...prev, pending };
    return emit(state, what ? `需要你确认：${what}` : "需要你确认一次工具调用", "polite", now);
  }

  // 5) 阶段：最新一次工具调用，按 id 去重 + 最小间隔。
  let last: CcToolCall | null = null;
  for (let i = view.messages.length - 1; i >= 0; i--) {
    const m = view.messages[i];
    if (m.kind === "tool") {
      last = m.tool;
      break;
    }
  }
  if (last && !prev.seenTools.includes(last.id)) {
    const state: AnnounceState = { ...prev, pending, seenTools: [...prev.seenTools, last.id] };
    const text = phaseText(last);
    if (!text || now - prev.at < PHASE_MIN_GAP_MS) return { state, say: null };
    return emit(state, text, "polite", now);
  }

  return { state: prev.pending === pending ? prev : { ...prev, pending }, say: null };
}
