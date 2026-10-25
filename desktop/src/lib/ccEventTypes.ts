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

export type CcRetryInfo = {
  attempt: number;
  max: number;
  message: string;
};

export type CcEvent =
  | { kind: "init"; sessionId: string; cwd: string | null; model: string | null }
  /** 用户自己的消息（后端本地事件，不来自 CLI）。 */
  | { kind: "userMessage"; text: string }
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
  messageCount: number;
  /** 最后活跃时间（秒）。 */
  updatedAt: number;
  events: CcEvent[];
  dropped: number;
};

/** `cc_probe` 的返回体。 */
export type CcProbe = {
  found: boolean;
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
