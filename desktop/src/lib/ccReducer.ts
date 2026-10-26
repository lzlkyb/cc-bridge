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
import { readUsageParts, type CcTurnStat } from "./ccTurnStat";

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
  /**
   * 输入侧的分项累计（会话级）。`inputTokens` 仍等于三者之和 —— 那是设置页
   * 统计在用的旧口径，不改；这三项是给「每轮脚注」做明细用的。
   *
   * 🔴 为什么要拆：`cache_read_input_tokens` 每轮都会重报（实测一轮 89K），
   * 只把它并进 input 累加，会话跑几轮后那个数字就虚高到没法读。
   */
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /**
   * 每一轮的用量与速度。**刻意不进 `messages`**：进消息流会连带影响会话内搜索、
   * 导出、分叉切点这一整圈消费者，而它们都不该看见统计行。渲染时按
   * `afterId` 把脚注插到对应消息之后。
   */
  turns: CcTurnStat[];
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
  /** 进程退出码。`null` = 还没退出。
   *
   *  ⚠️ **运行时恒为 `null`**：后端 `session.rs` 的读线程只在 stdout EOF 时发
   *  `Exit { code: None }`，从没等过子进程，所以拿不到真实退出码（只有单测里
   *  会塞 `Some(0)`/`Some(1)`）。判「进程死过」请用下面的 `processExited`。 */
  exitCode: number | null;
  /**
   * 进程在**这一轮跑到一半时**没了（崩溃 / 被杀 / 自己退出）。
   *
   * 为什么需要这个字段：`Exit` 事件本身不带退出码，也不区分「跑完一轮后进程被
   * 顺手收掉」和「中途挂了」—— 两者混起来会让每个恢复出来的历史会话都显示
   * 「已退出」。所以只在 `Exit` 到达时 `running` 仍为真（= 正在跑）才置位，
   * 一旦有新的 `init`（重开成功）立即复位。
   *
   * 它唯一的用途是**解释性**：后端下一轮会自动重建进程（`manager.rs` 的
   * `start()` 收尸后重起），界面不说的话用户只会觉得「刚才那句没反应」。
   */
  processExited: boolean;
  /**
   * 用户按停的落点：每个元素是一条消息 id，标记插在**那条消息之后**。
   * **空串** = 按停时一条消息都还没产出，此时落点在时间轴上位于所有消息之前
   * （渲染层把它挂在流开头，不是流尾 —— 挂流尾的话，等下一轮回复进来，
   * 「已停止」会跑到新回复下面，读起来像新那一轮被停了）。
   *
   * 为什么不塞进 `messages` 当一种新 kind：搜索、导出、分叉切点都在遍历消息数组，
   * 多一种「标记」会让它们各自长出一个排除分支，而它们本不该知道这件事。与
   * `turns` 同一个理由 —— 挂在视图上，渲染时按锚点插进去。
   *
   * ⚠️ 只记「用户主动停止」。`/clear` 的清空线**不在这里**：那是从消息内容本身
   *    （首 token 等于 `/clear`）推导出来的，所以连历史重放也自动有。
   */
  stops: string[];
  /**
   * 前端侧错误（invoke 失败、探测失败、润色失败）。与 `stderr` 分开，来源不同。
   *
   * 🔴 是**列表**不是单值：此前只有一个槽，连续两件事出错时后一条会把前一条顶掉，
   *    而先发生的那条往往更重要（探测失败会让后面一整套操作都失败）。渲染层
   *    每条一个 ×，各关各的。
   */
  errors: string[];
};

/** `turns` 只留最近这么多轮：它是渲染用的旁路数据，不是账本。 */
const MAX_TURNS = 500;

/** stderr 保留多少行。界面只显示最后两行，但多留一些是为了展开时还能看到一个
 *  完整的报错（启动失败的堆栈十来行）。**不无限累积**：同一个进程跑一整天，
 *  CLI 每轮吐一行 warning 就是几百行躺在 state 里，而且每条都会让整个视图重建。 */
const MAX_STDERR_LINES = 40;

/** 截到尾部 N 行（保留**最新**的：报错要看的是最近这次发生了什么）。 */
function capStderr(lines: string[]): string[] {
  return lines.length <= MAX_STDERR_LINES ? lines : lines.slice(-MAX_STDERR_LINES);
}

/** 前端错误最多留几条。不设上限的话，一个坏配置会让每轮都失败一次，
 *  横幅一叠十几条，把消息区挤到看不见。 */
const MAX_ERRORS = 5;

/**
 * 超限时**头尾各留**：第一条（根因）+ 最新的几条。
 *
 * 只留最新的会把根因挤掉 —— 一次探测失败会让之后每一步都失败一条，
 * 而那些后续错误的文案（「审批回写失败」「润色失败」）解释不了任何事情。
 * 只留最旧的又会冻住横幅：后面新发生的事一条都进不来。
 */
function capErrors(list: string[]): string[] {
  if (list.length <= MAX_ERRORS) return list;
  return [list[0], ...list.slice(-(MAX_ERRORS - 1))];
}

export const initialCcView: CcView = {
  messages: [],
  resolved: {},
  running: false,
  sessionId: null,
  model: null,
  cwd: null,
  inputTokens: 0,
  outputTokens: 0,
  uncachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  turns: [],
  modelUsage: {},
  retry: null,
  compactedTokens: null,
  backgroundTasks: 0,
  stderr: [],
  dropped: 0,
  exitCode: null,
  processExited: false,
  stops: [],
  errors: [],
};

export type CcAction =
  | { type: "event"; event: CcEvent }
  | { type: "replay"; events: CcEvent[]; dropped: number; running: boolean }
  | { type: "error"; message: string | null }
  /** 关掉第 `index` 条前端错误（每条红条自己的 ×）。 */
  | { type: "errorDismiss"; index: number }
  | { type: "sending" }
  /** 一次发送没能送达（invoke 失败 / 进程没起来）：撤回 `sending` 置上的乐观 running。
   *  与 `error` 分开 —— 错误横幅不该背「清 running」这个副作用（见 error 分支注释）。 */
  | { type: "sendAborted" }
  /**
   * 用户按了「停止」。**不是** `error`、也不是 `exit`：
   *
   * 🔴 `cc_interrupt` 走的是杀进程（`session.rs::kill` —— `start_kill` + `wait` +
   *    等读线程排干），所以 `Exit` 事件**一定会来**。而此刻 `running` 仍为真，
   *    `exit` 分支的判据 `processExited: view.running` 会把主动停止读成
   *    「跑到一半没了」，在顶部挂一条「claude 进程在生成中退出了（崩溃或被中断）」。
   *    用户按的是停止，不该被告知出了事故。
   *
   * 所以停止必须先落一步：置 `running: false`，紧接着来的 `Exit` 自然判成
   * 「正常收尾」；同时把落点记进 `stops`。
   */
  | { type: "interrupted" }
  /** 关掉 stderr 红条。与 `error` 分开：两者的来源不同、生命周期也不同
   *  （stderr 会跨轮累积，`error` 是这一次操作失败），共用一个 dismiss
   *  会让「关掉报错」看起来把 CLI 的错误也一起关了，实际没有。 */
  | { type: "stderrClear" };

/**
 * 从 `result.usage` 里挖出「输入侧总量」与 output。
 *
 * 保留这个薄封装只为一件事：`inputTokens` 的旧口径 = 未缓存 + 写缓存 + 读缓存
 * （设置页的统计按它算）。分项在 `readUsageParts` 里，别在这里重复实现。
 */
function readUsage(usage: Record<string, unknown> | null): { input: number; output: number } {
  const p = readUsageParts(usage);
  return { input: p.input + p.cacheWrite + p.cacheRead, output: p.output };
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
        // 同理：新进程的 stderr 与上一个进程无关。不清的话，启动失败留下的
        // 红条会一直挂在会话顶部 —— 用户改好配置重试成功了，界面还在报旧错，
        // 而那条红条的 × 关不掉它（此前只清前端 error）。这是实测过的真缺陷。
        stderr: [],
        // 重开成功 ⇒ 上一轮那次「进程没了」的提示必须撤掉，否则横幅会一直挂着。
        processExited: false,
        // 🔴 `stops` **不在这里清**。此前清过，理由是「新进程 = 新的会话链」——
        //    但停止点的锚是消息 id，消息数组并不会因为换进程而重建，指针依然有效。
        //    而「停止」这个动作本身就会杀进程（`cc_interrupt`），所以下一轮**必然**
        //    起一个新进程、必然来一条 `init` ⇒ 清空意味着「已停止」那条线在用户
        //    发出下一句的瞬间消失。翻回历史时只能看到半句话，正是这条线要拦的事。
        // 压缩是上一个进程里发生过的事；新进程的上下文是重新加载的。
        compactedTokens: null,
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
                  // 老流水没有这个字段 ⇒ `undefined`，卡片不显示耗时。
                  durationMs: event.durationMs ?? undefined,
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
      const parts = readUsageParts(event.usage);
      const costUsd = event.costUsd ?? view.costUsd;
      // 本轮成本 = 两次累计值之差。CLI 给的是**会话累计**（替换式），相减才是
      // 这一轮花的钱。`max(0, …)` 兜住累计被重置（换模型 / 中转重算）时的负数。
      const turnCost =
        typeof event.costUsd === "number" ? Math.max(0, event.costUsd - view.costUsd) : null;
      // 先收残留再取 `last`：脚注靠 `afterId` 找锚点，锚点若是被收掉的审批卡就找不到了。
      const messages = settleOpen(view);
      const last = messages[messages.length - 1];
      const stat: CcTurnStat = {
        afterId: last?.id ?? "",
        input: parts.input,
        cacheWrite: parts.cacheWrite,
        cacheRead: parts.cacheRead,
        output: parts.output,
        genMs: event.genMs ?? null,
        durationMs: event.durationMs ?? null,
        ttftMs: event.ttftMs ?? null,
        apiMs: event.apiMs ?? null,
        costUsd: turnCost,
        isError: event.isError,
      };
      return {
        ...view,
        messages,
        running: false,
        retry: null,
        sessionId: event.sessionId ?? view.sessionId,
        inputTokens: view.inputTokens + usage.input,
        outputTokens: view.outputTokens + usage.output,
        uncachedInputTokens: view.uncachedInputTokens + parts.input,
        cacheWriteTokens: view.cacheWriteTokens + parts.cacheWrite,
        cacheReadTokens: view.cacheReadTokens + parts.cacheRead,
        // CLI 给的是 `total_cost_usd`（会话累计，Rust 优先取它）⇒ **替换式**，与下方
        // modelUsage 同一判据。累加会把第 2 轮显示成「第 1 轮 + 两条累计」的虚高值。
        // 没带（老流水）就保留上一次的，不清空。
        costUsd,
        // 只留最近若干轮：`turns` 是渲染用的旁路数据，不是审计账本，
        // 长会话没必要为一个脚注无限增长。
        turns: [...view.turns, stat].slice(-MAX_TURNS),
        // 每轮都带 ⇒ 替换式更新（CLI 给的是累计值，累加会翻倍）。没带（老流水）
        // 就保留上一次的，不清空——清空会让余量条在一轮之间闪烁消失。
        modelUsage: event.modelUsage ? readModelUsage(event.modelUsage) : view.modelUsage,
        // `is_error` 时 `text` 往往是给人看的错误摘要，放 stderr 通道统一展示。
        stderr: event.isError && event.text ? capStderr([...view.stderr, event.text]) : view.stderr,
      };
    }
    case "stderr": {
      // 去重只对「相邻且完全相同」的批次：CLI 退出时同一段 stderr 可能既作为事件
      // 来一次、又随 Exit 再来一次。全局去重会吞掉 CLI 在不同时刻合法重复的同一行
      // （构建工具的重复警告很常见），而且 `includes` 对长列表是 O(n²)。
      const batch = event.lines.join("\n");
      const tail = view.stderr.slice(-event.lines.length).join("\n");
      if (batch !== "" && batch === tail) return view;
      return { ...view, stderr: capStderr([...view.stderr, ...event.lines]) };
    }

    case "exit":
      // 🔴 进程退出（崩溃 / 被 kill / CLI 自己退）时必须有它兜底：这些路径不会有
      // `result`/TurnEnd，没有 Exit 界面会永远停在「进行中」。
      // 正常多轮复用进程时**不会**来 Exit —— 轮次靠 TurnEnd 落定，两者别混。
      // 退避重试中被打断也一样退干净：留着「重试中」横幅和「已退出」并排是矛盾信息。
      // `running` 在这一刻的值就是判据：为真 ⇒ 跑到一半没了（值得提示），
      // 为假 ⇒ 一轮正常落定后进程被收掉（满大街都是，不能拿它刷屏）。
      return {
        ...view,
        messages: settleOpen(view),
        running: false,
        exitCode: event.code,
        retry: null,
        processExited: view.running,
      };

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
      // 前端侧错误（探测失败之类）不属于事件流，保留 —— 重放的是历史，不是这次操作。
      let next: CcView = { ...initialCcView, errors: view.errors };
      for (const e of action.events) next = applyEvent(next, e);
      // 🔴 `processExited` 必须归零：这里重放的是**库里那条会话的历史**，不是本次运行。
      // 历史流水末尾那条 `Exit` 只说明上次结束得不干净（崩溃 / 强杀），把它显示成
      // 「刚才崩了、下一句会重开」是错的 —— 此刻还没起进程，那句话反而让人以为
      // 有进程刚死。真崩溃走 `event` 路径（那时 `running` 来自下面这个快照），不受影响。
      return {
        ...next,
        dropped: action.dropped,
        running: action.running,
        processExited: false,
      };
    }
    case "sending":
      // `compactedTokens` 在这里清：那条提示描述的是**刚刚那一轮**发生过的事，
      // 只该活到「下一轮开始」。不清的话它会在会话顶部一直挂到进程重启 ——
      // 文案是「更早的细节模型不再逐字记得」，常驻读起来像「现在仍处于压缩态」。
      // 前端错误一并清：它是「上一次操作没成功」，用户已经重新发了一轮，留着只会
      // 在流里叠成噪音（旧实现只有一个槽，也是这么清的）。
      return {
        ...view,
        running: true,
        errors: [],
        retry: null,
        exitCode: null,
        compactedTokens: null,
      };
    case "error":
      // 🔴 不动 `running`：错误横幅与轮次是两件正交的事 —— 运行中润色失败、审批
      // 回写失败、用户点掉横幅都会走这里，顺手清 running 会把进行中的一轮伪装成
      // 空闲，队列会在假空闲窗口里把下一条发出去、被后端拒收 ⇒ 消息丢失。
      // 乐观发送失败要撤 running 用 `sendAborted`（它明确对应「这一轮没起来」）。
      //
      // `message: null` = 清空整列（旧语义的「关掉横幅」）；单条关闭走 `errorDismiss`。
      if (action.message === null) {
        return view.errors.length === 0 ? view : { ...view, errors: [] };
      }
      return { ...view, errors: capErrors([...view.errors, action.message]) };
    case "errorDismiss": {
      // 只摘掉这一条：其它红条各有各的原因，一起消失会让用户以为都修好了。
      if (!view.errors[action.index]) return view;
      return { ...view, errors: view.errors.filter((_, i) => i !== action.index) };
    }
    case "sendAborted":
      return { ...view, running: false };
    case "interrupted": {
      // 用户主动停：这一轮不会再有 `turnEnd`，界面自己收尾（与 `exit` 同一套清理）。
      // `processExited` 显式压掉是本 action 存在的**主要理由** —— 紧接着到达的
      // `Exit` 会拿 `running` 当判据，而它此刻若还是 true，就会把「我按了停止」
      // 记成「跑到一半崩了」。
      const settled = settleOpen(view);
      const at = anchorAfter(settled);
      return {
        ...view,
        messages: settled,
        running: false,
        retry: null,
        processExited: false,
        // 只在真有一轮在跑时落点：连点两下停止不该多出一条标记。
        // 同一锚点也只留一条：停止后队列推着下一轮起来又停，锚点会重复。
        stops: view.running ? [...view.stops.filter((s) => s !== at), at] : view.stops,
      };
    }
    case "stderrClear":
      // 只清 stderr，不碰前端 `errors`：用户点的那个 × 属于哪条红条，就只关哪一条。
      return view.stderr.length === 0 ? view : { ...view, stderr: [] };
    default: {
      /**
       * 🔴 穷尽性检查，别删。
       *
       * `CcAction` 是**封闭**联合，上面每个 `type` 都必须有一个分支。此前这里是
       * `default: return view`，于是新增一个动作却忘了写分支时 tsc 一声不响，表现
       * 是「按钮点了没反应」—— 上一批加 `interrupted` 与 `errorDismiss` 时各漏过
       * 一次，两次都是靠人翻代码才发现的。
       *
       * 把这行 `never` 赋值留着：多出一个没处理的动作，这里就编译报错。
       */
      const missing: never = action;
      void missing;
      return view;
    }
  }
}

/**
 * 一轮落定（`turnEnd`）或进程退出（`exit`）时，收掉已经不可能再有下文的残留：
 *  - 没有裁决的审批 / 提问卡：请求已随这一轮结束而作废，留着会一直转「N 秒后自动拒绝」，
 *    侧栏显示「待批准」，点按钮还会因后端找不到请求而报错；
 *  - 仍是「执行中」的工具卡：进程被杀 / 被中断时拿不到 `tool_result`，不收的话会永远转圈。
 *
 * 没有残留时原样返回 `view.messages`（引用不变，不触发多余的重渲染）。
 * 与 `permissionCancel` 同一口径：审批卡直接移除，不留「已取消」的壳。
 */
function settleOpen(view: CcView): CcMessage[] {
  let changed = false;
  const out: CcMessage[] = [];
  for (const m of view.messages) {
    if (m.kind === "approval" && !view.resolved[m.id]) {
      changed = true;
      continue;
    }
    if (m.kind === "tool" && m.tool.status === "running") {
      changed = true;
      out.push({
        ...m,
        tool: {
          ...m.tool,
          status: "error",
          isError: true,
          result: m.tool.result ?? "已中断，没有拿到执行结果",
        },
      });
      continue;
    }
    out.push(m);
  }
  return changed ? out : view.messages;
}

/**
 * 停止点锚在哪条消息之后。
 *
 * 空串 = 按停时一条消息都没有（刚发出去就停且消息还没落地），标记挂到**流开头**
 * —— 那个落点在时间轴上位于所有消息之前（`MessageList` 里 `stopSet.has("")` 渲染
 * 在最前面）。挂流尾的话，等下一轮回复进来，这条「已停止」会跑到新回复下面，
 * 读起来像「刚才那一轮（已经成功的那轮）被停了」。
 *
 * 入参必须是 `settleOpen` 处理**之后**的消息：它会把不可能再有下文的审批卡
 * 摘掉，拿旧数组算锚点会指向一条已经不渲染的 id，标记就永远不出现。
 */
function anchorAfter(messages: CcMessage[]): string {
  return messages[messages.length - 1]?.id ?? "";
}

/** 有没有卡在等用户决定的审批。composer 据此提示「先处理上面的审批」。 */
export function pendingApprovals(view: Pick<CcView, "messages" | "resolved">): string[] {
  return view.messages
    .filter((m): m is Extract<CcMessage, { kind: "approval" }> => m.kind === "approval")
    .filter((m) => !view.resolved[m.id])
    .map((m) => m.id);
}
