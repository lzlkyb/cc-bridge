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
  /**
   * CC 自己的 session id（`Init` 事件里的那个）。侧栏「历史」区靠它去重：
   * 这条会话已经在某个 pane 里开着，就不要再在历史里摆一遍。
   * `null` = 还没起过进程（必然也还没进库）。
   */
  cliSessionId: string | null;
  /**
   * 库里那一行的行号（`cc_restore` 返回的，或「从历史打开」时那一行的）。
   * `null` = 还没落过盘（新会话、一句话都没说）。
   *
   * 与 `cliSessionId` **两个都要**：刚恢复的那一瞬间还没有 `Init` 事件
   * （`view.sessionId` 仍为 null），但有行号 —— 只靠 session id 对账的话，
   * 已打开的那条会在历史区里短暂再出现一次，用户点它就会开出重复的一条。
   */
  rowId: number | null;
  /** 侧栏标题：首条用户消息的首行；没有消息就是「新对话」。 */
  title: string;
  /** 用户消息条数（= 轮数）。 */
  turns: number;
  state: CcPaneState;
  /**
   * 覆盖 hover 提示（`STATE_HINT[state]` 的例外）。
   *
   * 为什么要这个口子：`dead` 这一个态现在承载两种完全不同的原因 —— 远端连接被删
   * （「连接已断」，重连才有救）与 claude 进程中途挂了（「进程已退出」，发下一句
   * 就重开）。两者对用户下一步该做什么的指示相反，混成一句会误导人。
   */
  stateHint?: string;
  /** 行内第二段：一句话说清「现在在干什么」。 */
  detail: string;
  /** 分组键：`""` = 本机，其余是 SSH 连接 id。 */
  connectionId: string;
  /** 分组显示名（本机 / 连接名）。 */
  targetLabel: string;
  /**
   * 这条会话**即将使用**的工作目录（输入框里的值）。`""` = 没填，落到 CLI 默认目录。
   *
   * 取输入框而不是 `view.cwd`：后者是上一轮真正用的，用户改了目录还没发消息时
   * 两者不同 —— 而同目录并发判定关心的是「按下发送会落到哪里」。
   */
  cwd: string;
  /**
   * 这条 pane 还在**载入库里那条会话**（`cc_restore` 未回来 / 事件流未就绪）。
   *
   * 侧栏用它挡一个真实的竞态：恢复完成前，这条会话的 `rowId` 与 `cliSessionId`
   * 都还是 `null`，历史区**对不上账**，于是正在恢复的那条会照样摆在那里 ——
   * 用户点它，就开出重复的第二条。所以只要有 pane 在恢复中，历史区整体不摆。
   *
   * 不拿「meta 还没上报」当判据：pane 挂载那一刻就报了（标题「新对话」），
   * 而那时恢复才刚开始。必须有这个显式位。
   */
  restoring: boolean;
  /**
   * 未决那条请求的 id 与超时秒数 —— 侧栏行用它跑倒计时。
   *
   * 只给「是谁、多久」，**不给「还剩多久」**：剩余时间由渲染层按挂载时刻往下数，
   * 在这里算的话，每次渲染（流式输出每 tick 都会重算 meta）都会把剩余时间重置一遍，
   * 倒计时就永远停在 60。
   */
  askId: string | null;
  askExpiresInSec: number;
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
  /** 输入框里的工作目录（不是 `view.cwd`，理由见 `CcPaneMeta.cwd`）。 */
  cwd: string | null;
  /** 还在载入库里那条会话（理由见 `CcPaneMeta.restoring`）。 */
  restoring: boolean;
  /**
   * 用户手写的标题（3-1d）。有它就压过「首条用户消息」派生的标题。
   *
   * 为什么要这个口子：改名写的是库里的 `title`，而界面上的标题本来是**现算**的
   * —— 那条消息还在，现算永远是旧内容。不给口子的话，用户改完名字发现侧栏
   * 一点变化都没有（历史区那条却变了），像是只改了一半。
   */
  titleHint?: string | null;
}): CcPaneMeta {
  const { view, pending, connectionId, targetLabel, targetAlive, cwd, restoring, titleHint } =
    input;
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
  let stateHint: string | undefined;
  if (!targetAlive) {
    state = "dead";
    detail = turns === 0 ? "连接已断" : `${turns} 轮 · 连接已断`;
  } else if (view.processExited) {
    // 生成到一半进程没了（崩溃 / 被杀）。后端下一轮会自己收尸重开（带 `--resume`），
    // 所以这里**只提示不阻止**：用户接着打字就能继续，前面的对话也不丢。
    // 排在审批之前：进程都没了，上一轮那些待批单在新进程里永远满足不了。
    state = "dead";
    detail = turns === 0 ? "进程已退出" : `${turns} 轮 · 进程已退出`;
    stateHint = "claude 进程中途退出了 · 发下一句会带 --resume 重开";
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
    cliSessionId: view.sessionId,
    rowId: null, // 同上：库里的行号只有调用方（restore 的返回值）知道
    title: titleHint?.trim() || titleOf(view),
    turns,
    state,
    stateHint,
    detail,
    connectionId: connectionId ?? "",
    targetLabel,
    cwd: cwd?.trim() ?? "",
    restoring,
    // 与 `state` 同一优先级取同一条（approval 先于 question），否则会出现
    // 「行上写待批准、倒计时却在数另一条提问」的错位。
    askId: (approval ?? question)?.id ?? null,
    askExpiresInSec: (approval ?? question)?.expiresInSec ?? 0,
  };
}

/**
 * 同目录并发的「对方标题」。没有冲突就是 `null`。
 *
 * 判据（`docs/批3-1c历史会话与同目录并发-2026-10-25.md` D4）：
 * **同目标 + 同目录 + 对方真在跑**（run / ask / wait）。
 *
 * 为什么要求对方在跑：两条空白会话目录都空着是常态（都落到 CLI 默认目录），
 * 只看「目录相同」会天天误报。为什么自己跑没跑不重要：我要发消息就会撞上，
 * 提示的价值在于**发之前**看得到。
 *
 * 空目录也参与比较 —— 两条都不填就是同一个默认目录，一样会打架。
 */
export function conflictWith(
  self: CcPaneMeta | null,
  others: (CcPaneMeta | null)[],
): string | null {
  if (!self) return null;
  for (const o of others) {
    if (!o || o === self) continue;
    if (o.connectionId !== self.connectionId) continue;
    if (o.cwd !== self.cwd) continue;
    if (o.state === "run" || o.state === "ask" || o.state === "wait") return o.title;
  }
  return null;
}

/** 侧栏底栏那句「N 个在跑 · 共 M 个」。 */
export function paneSummary(metas: CcPaneMeta[]): string {
  const running = metas.filter((m) => m.state === "run" || m.state === "ask" || m.state === "wait")
    .length;
  return `${running} 个在跑 · 共 ${metas.length} 个`;
}
