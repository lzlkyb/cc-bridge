/**
 * CC 对话页的数据形状（实验功能）。
 *
 * 🔴 形状刻意对齐 Claude Code 的 stream-json 协议，而不是围着界面凑：
 *    `assistant` 消息里的 `tool_use`（`name` + `input`）、`user` 消息里的
 *    `tool_result`（`content` + `is_error`）、`control_request{can_use_tool}`
 *    （`tool_name` + `input` + `decision_reason`）。
 *    接真协议时只换数据源，渲染层不用动。
 */

import type { CcModelUsage } from "./ccContextUsage";
import type { ChangesetEntry } from "./ccChangeset";

export type CcToolStatus = "running" | "ok" | "error";

export type CcToolCall = {
  id: string;
  /** 工具名原样保留（Read / Edit / Write / Bash…），不做归一化 —— 归一化该在 Rust 侧做。 */
  name: string;
  /** 协议原始入参。各工具的字段形状不同，渲染层自己按 name 取。 */
  input: Record<string, unknown>;
  status: CcToolStatus;
  durationMs?: number;
  /** `tool_result.content` 的纯文本形态。 */
  result?: string;
  /** `tool_result.is_error`。 */
  isError?: boolean;
};

/** 权限模式：与 CLI 的 `--permission-mode` 取值同名。 */
export type CcPermissionMode = "plan" | "default" | "acceptEdits" | "bypassPermissions";

/**
 * `AskUserQuestion` 的一道题。形状来自真机 `control_request.input.questions`
 * （2026-10-24 探针），不是照文档写的。
 */
export type CcQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

export type CcApproval = {
  kind: "approval";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  /** 协议里的 `decision_reason`，原样展示 —— 用户要知道"为什么问我"。 */
  reason: string;
  /** 审批有超时（CLI 侧 60s），到点自动拒绝。界面必须显式呈现，不能只转圈。 */
  expiresInSec: number;
  /**
   * 提问的题目。只有 `AskUserQuestion` 非空；普通工具审批没有这个字段。
   *
   * 答案要按 `{问题文本: [选项 label…]}` 回传 —— 协议里它走
   * `updatedInput.answers`，没有独立通道（实测：不带 answers 回 allow，
   * 模型收到的是「用户没有回答」）。
   */
  questions?: CcQuestion[];
};

export type CcMessage =
  | { kind: "user"; id: string; text: string; at: string }
  | { kind: "assistant"; id: string; text: string; at: string }
  /** 思维链。**默认折叠**：CC 的思考动辄几分钟，摊在流里会把正文冲出视口。 */
  | { kind: "thinking"; id: string; text: string; at: string }
  | { kind: "tool"; id: string; tool: CcToolCall; at: string }
  | CcApproval;

export type CcSession = {
  /** SSH 连接名（cc-bridge 的既有概念）。 */
  connection: string;
  cwd: string;
  branch: string;
  /**
   * **CC 的** session id（`system/init` 给的那个）。
   *
   * 与 `CcPaneMeta.sessionId` 不是一回事：那个是 cc-bridge 内部的会话 id
   * （`cc_new_session` 铸发）。这里要的是 CLI 自己的 id —— 审计日志的
   * `ccSessionId` 字段记的就是它，传错就永远查不到工具调用（批 4-1）。
   */
  sessionId: string | null;
  /** 我们为**下一轮**选的模型。空串 = 不传 `--model`（跟随 CLI 默认）。 */
  model: string;
  /** CLI 在 `system/init` 里回报的**当前**模型。选择为空时界面显示它。 */
  activeModel?: string | null;
  permissionMode: CcPermissionMode;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** 各模型累计用量与上下文窗口（会话条余量条的数据源，解析见 `lib/ccContextUsage.ts`）。 */
  modelUsage: Record<string, CcModelUsage>;
  /** 有没有一轮正在跑。会话条用它切换连接点的颜色（绿 = 忙）。 */
  running: boolean;
  /** 本会话改过的文件（变更集面板数据源，聚合见 `lib/ccChangeset.ts`）。 */
  changeset: ChangesetEntry[];
  messages: CcMessage[];
};

export const PERMISSION_MODE_LABEL: Record<CcPermissionMode, string> = {
  plan: "计划",
  default: "需批准",
  acceptEdits: "自动改",
  bypassPermissions: "全自动",
};

/**
 * 🔴 `bypassPermissions` 下 `can_use_tool` **根本不触发**（协议层事实），
 *    也就是这项模式下界面彻底失去把关权。切到它时必须明示，不能只是换个高亮。
 */
export const PERMISSION_MODE_RISK: Partial<Record<CcPermissionMode, string>> = {
  bypassPermissions: "此模式下不再弹出审批，工具将无审核执行",
};
