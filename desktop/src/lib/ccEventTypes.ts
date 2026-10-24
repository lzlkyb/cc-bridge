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
  | { kind: "permissionResolved"; requestId: string; decision: "allow" | "deny" }
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
      costUsd: number | null;
      numTurns: number | null;
      durationMs: number | null;
    }
  | { kind: "stderr"; lines: string[] }
  | { kind: "exit"; code: number | null };

/** 后端 `cc_session::manager::CC_EVENT` 的值。改名必须两处一起改。 */
export const CC_EVENT_NAME = "cc-event";

/** `cc-event` 的载荷：带序号，用于订阅与快照之间的去重。 */
export type CcEventPayload = { seq: number; event: CcEvent };

/** `cc_snapshot` 的返回体。 */
export type CcSnapshot = {
  events: CcEvent[];
  nextSeq: number;
  /** `> 0` ⇒ 缓冲溢出，更早的内容已经被挤掉了，界面必须提示。 */
  dropped: number;
  running: boolean;
  resumeId: string | null;
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
 * 审批超时（CLI 侧固定 60s 自动拒绝）。
 *
 * 协议里**不发**剩余时间，所以只能按收到卡片的那一刻起算。误差只影响文案，
 * 真正的裁决由 CLI 自己的计时器做，界面不参与决策。
 */
export const APPROVAL_TIMEOUT_SEC = 60;
