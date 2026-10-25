/**
 * 一条对话会话 → 侧栏那一行要显示的东西。**纯函数**，不碰 React、不碰 IPC。
 *
 * 单独成文的原因：侧栏标题/状态点/副标题三件事都由它决定，而它对
 * 「首条用户消息怎么切」「五态优先级谁压谁」有明确取舍 —— 这些取舍必须能被
 * 单元测试钉住，否则将来加一种事件就可能悄无声息地把「待批准」显示成「生成中」，
 * 而那个错误的代价是用户以为 AI 在自己跑、其实它已经卡在那里等人点头。
 *
 * 🔴 五态的判据全部来自**我们自己的事件流**（`CcView`），不 screen-scrape：
 *    - `ask`  = 有未决的工具审批（用户必须点）；
 *    - `wait` = 有未决的提问卡（`AskUserQuestion`，用户必须选）；
 *    - `run`  = 有活跃轮次；
 *    - `idle` = 其它（跑完了 / 还没开始）；
 *    - `dead` = 目标连接已经不在列表里（远端被删），行要标灰。
 *
 * `dead` 只判「连接没了」这一种确定情况。**进程死没死现在判不出来** ——
 * `Exit` 事件每轮都会来（见 `ccReducer` 的 exit 分支），拿它当判据会把每一轮
 * 结束都标成「已死」。真正的存活判据要等 3-2 的会话不死（tmux 托管后能查），
 * 到那时只需在 `dead` 之前多一个分支，调用方不用改。
 */

import type { CcView } from "./ccReducer";
import type { CcMessage } from "./ccGuiTypes";

/** 侧栏状态点五态。class 名在 `SessionSidebar` 里映射，这里只管语义。 */
export type CcPaneState = "run" | "ask" | "wait" | "idle" | "dead";

export type CcPaneMeta = {
  /** 内部会话 id（`cc_new_session` 铸发）。`null` = 还没铸发完。 */
  sessionId: number | null;
  /** 侧栏标题：首条用户消息的首行；没有消息就是「新对话」。 */
  title: string;
  /** 用户消息条数（= 轮数）。 */
  turns: number;
  state: CcPaneState;
  /** 行内第二段：一句话说清「现在在干什么」。 */
  detail: string;
  /** 分组键：`""` = 本机，其余是 SSH 连接 id。 */
  connectionId: string;
  /** 分组显示名（本机 / 连接名）。 */
  targetLabel: string;
};

/** 标题上限。240px 侧栏减掉状态点与内边距后大约放得下 13~14 个汉字。 */
const TITLE_MAX = 40;

/**
 * 首条用户消息 → 标题。
 *
 * 只取**第一行**：用户常常先贴一大段日志再提问，把整段塞进单行省略号的
 * 效果是「看起来都一样」。多行输入的标题用第一行最有辨识度。
 */
function titleOf(view: CcView): string {
  const first = view.messages.find((m) => m.kind === "user");
  if (!first || first.kind !== "user") return "新对话";
  const line = first.text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (!line) return "新对话";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
}

export function derivePaneMeta(input: {
  view: CcView;
  /** 未决审批 id（`pendingApprovals(view)` 的结果）。外面算好传进来，避免重复扫消息。 */
  pending: string[];
  connectionId: string | null;
  targetLabel: string;
  /** 目标连接还在不在（远端被删 ⇒ false）。本机恒 true。 */
  targetAlive: boolean;
}): CcPaneMeta {
  const { view, pending, connectionId, targetLabel, targetAlive } = input;
  const turns = view.messages.reduce((n, m) => (m.kind === "user" ? n + 1 : n), 0);

  // 未决卡片里先看「需要选的」还是「需要批的」其实无所谓 —— 两者都要求用户动手，
  // 但界面上「等你选」比「待批准」更能提示这是一道选择题，故分开。
  const asks = view.messages.filter(
    (m): m is Extract<CcMessage, { kind: "approval" }> =>
      m.kind === "approval" && pending.includes(m.id),
  );
  const question = asks.find((m) => (m.questions?.length ?? 0) > 0);
  const approval = asks.find((m) => (m.questions?.length ?? 0) === 0);

  let state: CcPaneState = "idle";
  let detail = turns === 0 ? "新会话" : `${turns} 轮 · 空闲`;
  if (!targetAlive) {
    state = "dead";
    detail = turns === 0 ? "连接已断" : `${turns} 轮 · 连接已断`;
  } else if (approval) {
    // 待批准优先于「等你选」：两条都卡着时，先显示更危险的那条（工具要动文件）。
    state = "ask";
    detail = `待批准 · ${approval.toolName}`;
  } else if (question) {
    state = "wait";
    detail = `等你选 · ${question.toolName}`;
  } else if (view.running) {
    state = "run";
    detail = turns === 0 ? "生成中" : `${turns} 轮 · 生成中`;
  }

  return {
    sessionId: null, // 由调用方按 `sessionIdRef` 回填：纯函数拿不到 ref 里的值
    title: titleOf(view),
    turns,
    state,
    detail,
    connectionId: connectionId ?? "",
    targetLabel,
  };
}

/** 侧栏底栏那句「N 个在跑 · 共 M 个」。 */
export function paneSummary(metas: CcPaneMeta[]): string {
  const running = metas.filter((m) => m.state === "run" || m.state === "ask" || m.state === "wait")
    .length;
  return `${running} 个在跑 · 共 ${metas.length} 个`;
}
