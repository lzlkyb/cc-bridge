/**
 * 对话事件 → 界面状态。**纯函数**，不碰 React、不碰 IPC。
 *
 * 🔴 一条硬约束：实时事件与「切页回来重放的事件」必须走**同一个** reducer。
 *    如果为重建单独写一套拼装逻辑，两者迟早长出差异，而差异只会在
 *    「切了一次标签页」之后出现 —— 测试很难覆盖，用户一眼就发现。
 *
 * 🔴 重放必须幂等到「不会重复两遍」。所以：
 *    - 助手正文按 `blockId` 合并，不按到达顺序追加；
 *    - 用户消息 id 由「已有几条用户消息」推导，不取时间戳；
 *    - 审批卡按 `requestId` 去重。
 */

import {
  APPROVAL_TIMEOUT_SEC,
  type CcEvent,
  type CcRetryInfo,
} from "./ccEventTypes";
import type { CcMessage } from "./ccGuiTypes";

export type CcView = {
  messages: CcMessage[];
  /** 已落定的审批：`requestId → 裁决`。与消息列表分开存，渲染层只读它。 */
  resolved: Record<string, "allow" | "deny">;
  running: boolean;
  sessionId: string | null;
  model: string | null;
  cwd: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** 正在退避重试。**不是错误**：CLI 会重试 10 次、每次 30s+ 后继续。 */
  retry: CcRetryInfo | null;
  /** 上下文被压缩后的 token 数（`null` = 本轮没压缩过）。 */
  compactedTokens: number | null;
  backgroundTasks: number;
  /** CLI 侧的错误信息：stderr 原文 + `result.is_error` 的摘要。启动失败、模型名不对、
   *  认证过期**只在这里**，stdout 上什么都看不到。 */
  stderr: string[];
  /** 环形缓冲溢出条数。`> 0` ⇒ 更早的内容已被挤掉，界面要提示。 */
  dropped: number;
  /** 进程退出码。`null` = 还没退出。 */
  exitCode: number | null;
  /** 前端侧错误（invoke 失败、探测失败）。与 stderr 分开，来源不同。 */
  error: string | null;
};

export const initialCcView: CcView = {
  messages: [],
  resolved: {},
  running: false,
  sessionId: null,
  model: null,
  cwd: null,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  retry: null,
  compactedTokens: null,
  backgroundTasks: 0,
  stderr: [],
  dropped: 0,
  exitCode: null,
  error: null,
};

export type CcAction =
  | { type: "event"; event: CcEvent }
  | { type: "replay"; events: CcEvent[]; dropped: number; running: boolean }
  | { type: "error"; message: string | null }
  | { type: "sending" }
  | { type: "reset" };

/** 从 `result.usage` 里挖 token 数。字段名是 API 原样的 snake_case。 */
function readUsage(usage: Record<string, unknown> | null): { input: number; output: number } {
  if (!usage) return { input: 0, output: 0 };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
  return { input, output: num(usage.output_tokens) };
}

/** 下一条用户消息的 id。**不取时间戳**：重放时会变成另一串 id，React key 全变。 */
function nextUserId(messages: CcMessage[]): string {
  let n = 0;
  for (const m of messages) if (m.kind === "user") n += 1;
  return `user:${n}`;
}

function upsertText(messages: CcMessage[], blockId: string, text: string, streaming: boolean): CcMessage[] {
  const idx = messages.findIndex((m) => m.kind === "assistant" && m.id === blockId);
  if (idx < 0) {
    return [...messages, { kind: "assistant", id: blockId, at: "", text }];
  }
  const cur = messages[idx];
  if (cur.kind !== "assistant") return messages;
  const next = streaming ? cur.text + text : text;
  if (next === cur.text) return messages; // 完全相同的碎片不制造新数组，省一次重渲染
  const copy = messages.slice();
  copy[idx] = { ...cur, text: next };
  return copy;
}

function applyEvent(view: CcView, event: CcEvent): CcView {
  switch (event.kind) {
    case "init":
      return {
        ...view,
        running: true,
        sessionId: event.sessionId || view.sessionId,
        model: event.model ?? view.model,
        cwd: event.cwd ?? view.cwd,
        // 新一轮起来了，上一轮的退出码不再有意义。
        exitCode: null,
        retry: null,
      };

    case "userMessage":
      return {
        ...view,
        messages: [
          ...view.messages,
          { kind: "user", id: nextUserId(view.messages), at: "", text: event.text },
        ],
      };

    case "text":
      return { ...view, messages: upsertText(view.messages, event.blockId, event.text, event.streaming) };

    // 思维链目前不渲染：CC 的「思考中」往往几分钟，占屏反而让人以为卡住。
    // 事件照收不误（Rust 侧有测试保证不漏），将来加折叠面板时不用改协议层。
    case "thinking":
      return view;

    case "toolUse": {
      if (view.messages.some((m) => m.kind === "tool" && m.id === event.toolUseId)) {
        return view;
      }
      return {
        ...view,
        messages: [
          ...view.messages,
          {
            kind: "tool",
            id: event.toolUseId,
            at: "",
            tool: {
              id: event.toolUseId,
              name: event.name,
              input: event.input,
              status: "running",
            },
          },
        ],
      };
    }

    case "toolResult":
      return {
        ...view,
        messages: view.messages.map((m) =>
          m.kind === "tool" && m.id === event.toolUseId
            ? {
                ...m,
                tool: {
                  ...m.tool,
                  status: event.isError ? "error" : "ok",
                  result: event.content,
                  isError: event.isError,
                },
              }
            : m,
        ),
      };

    case "permissionAsk": {
      const id = event.requestId;
      if (view.messages.some((m) => m.kind === "approval" && m.id === id)) return view;
      return {
        ...view,
        messages: [
          ...view.messages,
          {
            kind: "approval",
            id,
            toolName: event.toolName,
            input: event.input,
            // `reason` 为空时也要给一句：空白比错误的解释更糟。
            reason: event.reason ?? "CC 需要你的确认才能继续。",
            expiresInSec: APPROVAL_TIMEOUT_SEC,
          },
        ],
      };
    }

    case "question": {
      // `AskUserQuestion` 与审批同构（都是 `control_request`），v1 借用审批卡呈现。
      // 差别在语义：这里是「选一个」，不是「放行」。文案上区分开。
      const id = event.requestId;
      if (view.messages.some((m) => m.kind === "approval" && m.id === id)) return view;
      return {
        ...view,
        messages: [
          ...view.messages,
          {
            kind: "approval",
            id,
            toolName: "AskUserQuestion",
            input: event.input,
            reason: "CC 在问你一个问题。允许 = 按问题里的默认选项继续，拒绝 = 让它别问、自己决定。",
            expiresInSec: APPROVAL_TIMEOUT_SEC,
          },
        ],
      };
    }

    case "permissionCancel":
      // CLI 撤回了请求（60s 超时或被打断）：卡片不能留着转圈。
      return {
        ...view,
        messages: view.messages.filter((m) => !(m.kind === "approval" && m.id === event.requestId)),
      };

    case "permissionResolved":
      return { ...view, resolved: { ...view.resolved, [event.requestId]: event.decision } };

    case "retry":
      return { ...view, retry: { attempt: event.attempt, max: event.max, message: event.message } };

    case "compact":
      return { ...view, compactedTokens: event.postTokens };

    case "backgroundTasks":
      return { ...view, backgroundTasks: event.pending };

    case "turnEnd": {
      const usage = readUsage(event.usage);
      return {
        ...view,
        running: false,
        retry: null,
        sessionId: event.sessionId ?? view.sessionId,
        inputTokens: view.inputTokens + usage.input,
        outputTokens: view.outputTokens + usage.output,
        costUsd: view.costUsd + (event.costUsd ?? 0),
        // `is_error` 时 `text` 往往是给人看的错误摘要，放 stderr 通道统一展示。
        stderr: event.isError && event.text ? [...view.stderr, event.text] : view.stderr,
      };
    }

    case "stderr":
      // 去重：CLI 退出时同一段 stderr 可能既作为事件来一次，又随 Exit 再来一次。
      return {
        ...view,
        stderr: [...view.stderr, ...event.lines.filter((l) => !view.stderr.includes(l))],
      };

    case "exit":
      // 🔴 每一轮都会收到。**不能只靠 turnEnd**：崩溃、被 kill、CLI 直接退出
      // 都不会发 `result`，那时界面会永远停在「进行中」。
      return { ...view, running: false, exitCode: event.code };

    default:
      return view;
  }
}

export function ccReducer(view: CcView, action: CcAction): CcView {
  switch (action.type) {
    case "event":
      return applyEvent(view, action.event);
    case "replay": {
      // 🔴 必须从**空状态**重放。从当前状态往上叠会把 token / cost 累加两遍，
      // 而账目类数字错了没人能一眼看出来，只会在月底对账时炸。
      // `error` 是前端侧的（探测失败之类），不属于事件流，保留。
      let next: CcView = { ...initialCcView, error: view.error };
      for (const e of action.events) next = applyEvent(next, e);
      return { ...next, dropped: action.dropped, running: action.running };
    }
    case "sending":
      return { ...view, running: true, error: null, retry: null, exitCode: null };
    case "error":
      return { ...view, error: action.message, running: false };
    case "reset":
      return { ...initialCcView };
    default:
      return view;
  }
}

/** 有没有卡在等用户决定的审批。composer 据此提示「先处理上面的审批」。 */
export function pendingApprovals(view: CcView): string[] {
  return view.messages
    .filter((m): m is Extract<CcMessage, { kind: "approval" }> => m.kind === "approval")
    .filter((m) => !view.resolved[m.id])
    .map((m) => m.id);
}
