/**
 * 后端 `cc_session::proto::CcEvent` 的前端镜像。
 *
 * 🔴 这一层**不做任何归一化**：形状原样照抄 Rust 的 serde 输出
 * （`tag = "kind"`，变体名与字段名都是 camelCase）。理由见源码分析 §一.1
 * 「前端几乎零引擎分支」——CLI 的原始形状随版本漂移，归一化的活全在 Rust 侧做完了，
 * 这里再包一层只会多一处会漂的地方。
 *
 * 对应关系检查方式：Rust 侧 `cargo test` 里有 `serde` 序列化断言，
 * 改任何一边都要同步改另一边的测试，别靠肉眼比对。
 */

import type { CcForkSeed } from "./ccFork";

export type CcRetryInfo = {
  attempt: number;
  max: number;
  message: string;
};

export type CcEvent =
  | { kind: "init"; sessionId: string; cwd: string | null; model: string | null }
  /** 用户自己的消息（后端本地事件，不来自 CLI）。 */
  | { kind: "userMessage"; text: string; images?: string[] }
  /** `streaming=true` 是增量追加，`false` 是最终全文覆盖，两者共用 `blockId`。 */
  | { kind: "text"; blockId: string; text: string; streaming: boolean }
  | { kind: "thinking"; blockId: string; text: string; streaming: boolean }
  | { kind: "toolUse"; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: "toolResult"; toolUseId: string; content: string; isError: boolean }
  | {
      kind: "permissionAsk";
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      toolUseId: string | null;
      reason: string | null;
    }
  | { kind: "permissionCancel"; requestId: string }
  | {
      kind: "permissionResolved";
      requestId: string;
      decision: "allow" | "deny";
      /**
       * 规则自动放行（Rust 侧 `autoapprove` 命中后直接裁决并补记的本地事件）。
       *
       * 可选是为了读老流水：2026-10-24 之前落盘的事件没有这个字段，
       * Rust 侧靠 `#[serde(default)]` 兜底，前端按 `undefined` 当人工处理。
       */
      auto?: boolean;
    }
  | { kind: "question"; requestId: string; toolUseId: string | null; input: Record<string, unknown> }
  | { kind: "retry"; attempt: number; max: number; message: string }
  | { kind: "compact"; postTokens: number }
  | { kind: "backgroundTasks"; pending: number }
  | {
      kind: "turnEnd";
      sessionId: string | null;
      isError: boolean;
      text: string | null;
      usage: Record<string, unknown> | null;
      /**
       * `result.modelUsage`：每个模型的累计用量与上下文窗口，上下文余量条的
       * 唯一数据源（探针 0-3）。字段是 camelCase，与 `usage` 的 snake_case
       * 不是一套命名。解析在 `lib/ccContextUsage.ts`。
       *
       * 可选同 `permissionResolved.auto`：2026-10-24 之前落盘的老流水没有
       * 这个字段（Rust 侧 `#[serde(default)]` 读回 `None`），前端按缺失
       * 当作「没带，保留上一次的」处理。
       */
      modelUsage?: Record<string, unknown> | null;
      costUsd: number | null;
      numTurns: number | null;
      durationMs: number | null;
    }
  | { kind: "stderr"; lines: string[] }
  | { kind: "exit"; code: number | null };

/** 后端 `cc_session::manager::CC_EVENT` 的值。改名必须两处一起改。 */
export const CC_EVENT_NAME = "cc-event";

/**
 * `cc-event` 的载荷：带序号，用于订阅与快照之间的去重。
 *
 * `sessionId` 是后端 `CcSessions` 铸发的**内部 id**（2026-10-25 多会话化），
 * 不是 CC 的 resume id —— 那个在 `event.kind === "init"` 里，只在 CLI 启动后
 * 才拿得到。前端只消化属于自己的那一条，其余原样忽略；单会话期也只有一条会进来。
 */
export type CcEventPayload = { seq: number; sessionId: number; event: CcEvent };

/** `cc_snapshot` 的返回体。 */
export type CcSnapshot = {
  events: CcEvent[];
  nextSeq: number;
  /** `> 0` ⇒ 缓冲溢出，更早的内容已经被挤掉了，界面必须提示。 */
  dropped: number;
  running: boolean;
  resumeId: string | null;
};

/**
 * `cc_restore` 的返回体：**上次**那条会话。
 *
 * 与 `CcSnapshot` 的分工：快照是「这个进程里发生过什么」（内存），恢复是
 * 「上个进程里发生过什么」（落盘的）。两者重叠时以快照为准 —— 活着的流水
 * 一定不比库里旧。判定在前端做（见 `useCcSession`）。
 */
export type CcRestore = {
  /**
   * 库里那一行的行号。侧栏「历史」区用它去重：这条已经在某个 pane 里开着，
   * 就不要在历史里再摆一遍。**新建的会话在首轮落盘之前拿不到它**（那时它还没进库）。
   */
  rowId: number;
  /** 空串 = 本机。恢复后要把目标切回这里，否则消息在、发下一句却是本机新会话。 */
  connectionId: string;
  cwd: string | null;
  /** 远端续聊必须的绝对路径。恢复时**不采信**它：可能已失效，重探更可靠。 */
  claudePath: string | null;
  model: string | null;
  permissionMode: string | null;
  sessionId: string | null;
  resumeId: string | null;
  title: string | null;
  /**
   * 标题是用户手写的（`cc_rename_session` 写过）。
   *
   * 只有它为 `true` 时，库里的 `title` 才是**权威标题**；否则那只是「首条用户
   * 消息的自动截断」，界面仍按消息现算（用户继续聊时标题跟着走）。
   */
  titleLocked: boolean;
  messageCount: number;
  /** 最后活跃时间（秒）。 */
  updatedAt: number;
  events: CcEvent[];
  dropped: number;
};

/**
 * 库里一条会话的摘要（`cc_list_stored`，侧栏「历史」区）。
 *
 * **没有 events**：正文是一行几十到几百 KB 的 `events_json`，列表只要标题与时间。
 * 点开某条时才由 `cc_restore({ rowId })` 把正文读出来。
 */
export type CcStoredSummary = {
  rowId: number;
  /** 空串 = 本机。 */
  connectionId: string;
  /** CLI 的 session id。与「已打开 pane」的 `view.sessionId` 对账去重用。 */
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  /** 标题是用户手写的（见 `CcRestore.titleLocked`）。 */
  titleLocked: boolean;
  preview: string | null;
  model: string | null;
  permissionMode: string | null;
  messageCount: number;
  /** 最后活跃时间（秒）。 */
  updatedAt: number;
  /** 归档时间（秒）。`null` = 未归档。只在「显示已归档」时才有非空值。 */
  archivedAt: number | null;
  /** 落盘时因超限被丢掉的事件数。 */
  dropped: number;
};

/**
 * 一条新 pane 的「要不要从库里载入」意图。
 *
 * 四态必须显式分开（3-1c / 3-3）。3-1b 是隐式的 —— 每个 pane 挂载都调 `cc_restore`
 * 取最近那条，于是 `+` 新建的第二条会**重复载入上一条的内容**。
 *
 * - `none`   — `+` / Ctrl+N 造的新会话，根本不调 `cc_restore`
 *              （不是调了再丢返回值：那会白读几 MB 的 `events_json`）；
 * - `latest` — 进页面造的第一条，接着上次聊（重启恢复）；
 * - `row`    — 侧栏「历史」里点开的那一条；
 * - `seed`   — 从某条消息分叉出来的新会话：**不读库**，挂载后把摘要 + 那句话
 *              发出去（见 `lib/ccFork.ts` 与 `CcPane` 的自动重跑）。
 */
export type CcRestoreReq =
  | { kind: "none" }
  | { kind: "latest" }
  | { kind: "row"; rowId: number }
  | { kind: "seed"; seed: CcForkSeed };

/** `cc_probe` 的返回体。 */
export type CcProbe = {  found: boolean;
  path: string;
  version: string | null;
  message: string;
  target: string;
};

/**
 * 历史列表里的一条（后端 `cc_history::index::Row`）。
 *
 * 注意它**不是**一条消息：只是「有这么一份转录」的索引。正文要 `cc_history_open`
 * 才读，读回来是一串 `CcEvent`（和实时流同一条渲染路径）。
 */
export type CcHistoryRow = {
  /** 空串 = 本机。 */
  connectionId: string;
  /** 文件名 stem，就是 `--resume` 要的 id。 */
  sessionId: string;
  path: string;
  cwd: string | null;
  gitBranch: string | null;
  /** 标题。CLI 的 `ai-title` 优先，否则是首条用户消息（后者占绝大多数）。 */
  title: string;
  preview: string | null;
  /** 用户消息条数，不是事件数。 */
  messageCount: number;
  fileSize: number;
  fileMtimeMs: number;
  /** 最后活跃（unix 秒），列表按它倒序。 */
  lastUsedAt: number;
  /** 正文有没有缓存在本机。远端断开时靠它。 */
  cached: boolean;
};

/** `cc_history_list` 的返回体。 */
export type CcHistoryList = {
  rows: CcHistoryRow[];
  /** 有几份转录读不开。`> 0` 时列表底部要说明。 */
  failed: number;
  /** `~/.claude/projects` 在不在。不在 ⇒ 列表空是正常的，显示引导而不是报错。 */
  dirFound: boolean;
  tookMs: number;
};

/**
 * `cc_history_open` 的返回体。
 *
 * `snapshot.events` 已经包含整段历史（开头补了一条 `Init`）——直接 `replay`，
 * **不要再逐条 `event`**，否则每条都会渲染两遍。
 */
export type CcHistoryOpened = {
  snapshot: CcSnapshot;
  /** 因体积上限被裁掉的头部事件数（`snapshot.dropped` 是环形缓冲溢出，两者相加才是全部缺口）。 */
  trimmed: number;
  title: string;
  /**
   * 这条历史在工作库里的行号（历史转录在 `cc_sessions` 里已有对应行时才有）。
   * 侧栏对账、改名 / 归档都要它 —— 接管后 `restored` 被清，这是唯一行号来源。
   */
  rowId: number | null;
  /**
   * 这条历史的工作目录。
   *
   * 🔴 必须写回工作目录输入框：`cc_start` 会拿它和内存里的 facts 比，
   * 不一致就判定「换了目录」，清掉 resume id —— 打开的历史变成一条新会话。
   */
  cwd: string | null;
};

/**
 * 审批超时（CLI 侧固定 60s 自动拒绝）。
 *
 * 协议里**不发**剩余时间，所以只能按收到卡片的那一刻起算。误差只影响文案，
 * 真正的裁决由 CLI 自己的计时器做，界面不参与决策。
 */
export const APPROVAL_TIMEOUT_SEC = 60;
