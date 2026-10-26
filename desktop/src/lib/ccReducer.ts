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
import type { CcMessage, CcQuestion } from "./ccGuiTypes";
import { readModelUsage, type CcModelUsage } from "./ccContextUsage";

export type CcView = {
  messages: CcMessage[];
  /** 已落定的审批：`requestId → 裁决`。与消息列表分开存，渲染层只读它。
   *  `auto` = 后端规则自动放行（`autoapprove` 命中后补记的本地事件）；
   *  2026-10-24 之前落盘的老流水没有这个字段，按 `undefined` 当人工裁决。 */
  resolved: Record<string, { decision: "allow" | "deny"; auto?: boolean }>;
  running: boolean;
  sessionId: string | null;
  model: string | null;
  cwd: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** 各模型累计用量与上下文窗口（`turnEnd.modelUsage` 解析结果）。空 = 还没有
   *  任何一轮带过这个字段（老流水 / 老版本 CLI）⇒ 界面只显示已用 token。 */
  modelUsage: Record<string, CcModelUsage>;
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
  modelUsage: {},
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
  /** 一次发送没能送达（invoke 失败 / 进程没起来）：撤回 `sending` 置上的乐观 running。
   *  与 `error` 分开 —— 错误横幅不该背「清 running」这个副作用（见 error 分支注释）。 */
  | { type: "sendAborted" };

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

/**
 * 思维链按 `blockId` upsert。与 `upsertText` 分开写而不是加个 kind 参数：
 * 两条链路将来会长出不同的折叠/计时行为，共用一份只会让分支越叠越深。
 */
function upsertThinking(messages: CcMessage[], blockId: string, text: string, streaming: boolean): CcMessage[] {
  const idx = messages.findIndex((m) => m.kind === "thinking" && m.id === blockId);
  if (idx < 0) {
    return [...messages, { kind: "thinking", id: blockId, at: "", text }];
  }
  const cur = messages[idx];
  if (cur.kind !== "thinking") return messages;
  const next = streaming ? cur.text + text : text;
  if (next === cur.text) return messages;
  const copy = messages.slice();
  copy[idx] = { ...cur, text: next };
  return copy;
}

/**
 * 从 `AskUserQuestion` 的入参里读出题目。
 *
 * 入参来自 CLI（`control_request.input`），字段形状**不能假设**：模型偶尔给
 * 没有 `options` 的题、`multiSelect` 缺失、`question` 为空。这里逐字段判型，
 * 读不出来的题直接丢掉 —— 卡片少一道题总比渲染出 `undefined` 好。
 *
 * 导出的目的是给 `readQuestions` 单独写测试：这段解析决定「用户能选什么」，
 * 而选项 label 又会被原样回传成答案，错了模型收到的是不存在的选项。
 */
export function readQuestions(input: Record<string, unknown>): CcQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): CcQuestion[] => {
    if (!item || typeof item !== "object") return [];
    const q = item as Record<string, unknown>;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    if (!question) return [];
    const options = Array.isArray(q.options)
      ? q.options.flatMap((opt) => {
          if (!opt || typeof opt !== "object") return [];
          const o = opt as Record<string, unknown>;
          const label = typeof o.label === "string" ? o.label.trim() : "";
          if (!label) return [];
          return [
            {
              label,
              description: typeof o.description === "string" ? o.description : undefined,
            },
          ];
        })
      : [];
    return [
      {
        question,
        header: typeof q.header === "string" ? q.header : undefined,
        multiSelect: q.multiSelect === true,
        options,
      },
    ];
  });
}

/**
 * 把勾选状态压成回传形状：`{问题文本: [选项 label…]}`。
 *
 * 和 `readQuestions` 是一进一出的一对：那边解 CLI 的入参，这边拼我们回传的
 * `updatedInput.answers`。空答案的题直接不出现 —— 回一个 `[]` 会让 Rust 侧
 * 既不算「回答」也不算「跳过」，卡在中间。
 *
 * 不复用勾选 state 的原因：那里面可能有用户点了又取消留下的空数组。
 */
export function buildAnswers(
  questions: CcQuestion[],
  picked: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const q of questions) {
    const labels = (picked[q.question] ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
    if (labels.length > 0) out[q.question] = labels;
  }
  return out;
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
          {
            kind: "user",
            id: nextUserId(view.messages),
            at: "",
            text: event.text,
            // 空数组不落进消息：`images: []` 与「没有这个字段」在渲染上是同一件事，
            // 但前者会让 `===` 比较永远不相等（memo 化的气泡白重渲染）。
            ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
          },
        ],
      };

    case "text":
      return { ...view, messages: upsertText(view.messages, event.blockId, event.text, event.streaming) };

    // 思维链渲染成**默认折叠**的一行：长任务里它是「还活着」的唯一证据，
    // 摊开却会把正文冲出视口。事件照收（Rust 侧有测试保证不漏）。
    case "thinking":
      return {
        ...view,
        messages: upsertThinking(view.messages, event.blockId, event.text, event.streaming),
      };

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
            // 批 4-2：留住工具调用 id，「我点的允许」才能对上「它改的文件」。
            toolUseId: event.toolUseId ?? null,
            // `reason` 为空时也要给一句：空白比错误的解释更糟。
            reason: event.reason ?? "CC 需要你的确认才能继续。",
            expiresInSec: APPROVAL_TIMEOUT_SEC,
          },
        ],
      };
    }

    case "question": {
      // `AskUserQuestion` 与审批同构（都是 `control_request`），但语义是「选择」。
      // 题目解析出来才渲染成选项；解析不出来就退回普通审批形态 ——
      // 宁可显示原始 JSON 让用户看着放行，也不要画出几张点不动的空卡。
      const id = event.requestId;
      if (view.messages.some((m) => m.kind === "approval" && m.id === id)) return view;
      const questions = readQuestions(event.input);
      return {
        ...view,
        messages: [
          ...view.messages,
          {
            kind: "approval",
            id,
            toolName: "AskUserQuestion",
            input: event.input,
            // 提问也是「一次调用」：对齐口径与审批一致（批 4-2）。
            toolUseId: event.toolUseId ?? null,
            reason:
              questions.length > 0
                ? "选好之后提交。不想答就跳过 —— 跳过后 CC 会自己决定。"
                : "这条提问没有可读的选项，只能整体放行或拒绝。",
            expiresInSec: APPROVAL_TIMEOUT_SEC,
            questions,
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
      return {
        ...view,
        resolved: {
          ...view.resolved,
          [event.requestId]: { decision: event.decision, auto: event.auto },
        },
      };

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
        // CLI 给的是 `total_cost_usd`（会话累计，Rust 优先取它）⇒ **替换式**，与下方
        // modelUsage 同一判据。累加会把第 2 轮显示成「第 1 轮 + 两条累计」的虚高值。
        // 没带（老流水）就保留上一次的，不清空。
        costUsd: event.costUsd ?? view.costUsd,
        // 每轮都带 ⇒ 替换式更新（CLI 给的是累计值，累加会翻倍）。没带（老流水）
        // 就保留上一次的，不清空——清空会让余量条在一轮之间闪烁消失。
        modelUsage: event.modelUsage ? readModelUsage(event.modelUsage) : view.modelUsage,
        // `is_error` 时 `text` 往往是给人看的错误摘要，放 stderr 通道统一展示。
        stderr: event.isError && event.text ? [...view.stderr, event.text] : view.stderr,
      };
    }

    case "stderr": {
      // 去重只对「相邻且完全相同」的批次：CLI 退出时同一段 stderr 可能既作为事件
      // 来一次、又随 Exit 再来一次。全局去重会吞掉 CLI 在不同时刻合法重复的同一行
      // （构建工具的重复警告很常见），而且 `includes` 对长列表是 O(n²)。
      const batch = event.lines.join("\n");
      const tail = view.stderr.slice(-event.lines.length).join("\n");
      if (batch !== "" && batch === tail) return view;
      return { ...view, stderr: [...view.stderr, ...event.lines] };
    }

    case "exit":
      // 🔴 进程退出（崩溃 / 被 kill / CLI 自己退）时必须有它兜底：这些路径不会有
      // `result`/TurnEnd，没有 Exit 界面会永远停在「进行中」。
      // 正常多轮复用进程时**不会**来 Exit —— 轮次靠 TurnEnd 落定，两者别混。
      // 退避重试中被打断也一样退干净：留着「重试中」横幅和「已退出」并排是矛盾信息。
      return { ...view, running: false, exitCode: event.code, retry: null };

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
      // 🔴 不动 `running`：错误横幅与轮次是两件正交的事 —— 运行中润色失败、审批
      // 回写失败、用户点掉横幅都会走这里，顺手清 running 会把进行中的一轮伪装成
      // 空闲，队列会在假空闲窗口里把下一条发出去、被后端拒收 ⇒ 消息丢失。
      // 乐观发送失败要撤 running 用 `sendAborted`（它明确对应「这一轮没起来」）。
      return { ...view, error: action.message };
    case "sendAborted":
      return { ...view, running: false };
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
