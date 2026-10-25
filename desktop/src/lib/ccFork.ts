import type { CcMessage, CcPermissionMode } from "./ccGuiTypes";

/**
 * 消息编辑 / 分叉的纯逻辑（批 3-3）。
 *
 * ## 为什么「从这条消息重跑」是**新会话**而不是回滚当前会话
 *
 * CLI 的会话是它自己的 JSONL 转录，一条 `session_id` 对应一整段历史；我们只有
 * `--resume <id>` 这一个续接手段，**没有「回到第 N 轮的原始状态」这种原语**
 * （CC 自己的 /rewind 靠改那份转录，而改用户的 `~/.claude/*` 是我们的红线）。
 *
 * 所以能诚实地做到的只有一件事：**另起一条会话**，把「这条消息之前」的对话
 * 压成一段纯文本摘要作为开场上下文，再发出（可编辑的）这句话。原会话一个字节
 * 都不动 —— 用户随时能回去。
 *
 * 代价必须写在界面上（见 `UserMessageActions` 的提示条）：
 * - 新会话的模型上下文里**没有**工具调用与文件改动，只有对话正文；
 * - 截断点之后的文件改动不会回滚（那是 git 的事，我们不假装能撤销）。
 *
 * ## 为什么摘要要从**头部**丢
 *
 * 超长时保留「离这句最近的上下文」比保留开场更有用 —— 用户往常常是在改
 * 最后几轮的说法。丢掉的量如实返回，界面要提示「更早的已省略」。
 */
export const FORK_DIGEST_MAX = 12_000;

/** 单条消息进摘要的上限。贴一大段日志当作一条消息时，别让它独占整个摘要。 */
const PER_MESSAGE_MAX = 800;

/** 一次分叉要带给新会话的全部信息。 */
export type CcForkSeed = {
  /**
   * 源会话的 CC session id（`null` = 源会话还没起过进程）。
   *
   * 只用于**标注来源**，不参与续接：拿它 `--resume` 出来的是同一条会话
   * （两个进程续同一个 id 会打架），那不是分叉。
   */
  sourceSessionId: string | null;
  /** 源会话的用户手写标题或自动标题，给新 pane 的提示用。 */
  sourceTitle: string;
  /** 空串 = 本机。新会话必须落在**同一个目标**上，否则上下文里的路径全对不上。 */
  connectionId: string;
  cwd: string;
  model: string;
  permissionMode: CcPermissionMode;
  /** 截断点之前的对话摘要（可能为空：从第一条消息处分叉时没有前缀）。 */
  digest: string;
  /** 被丢掉的更早消息条数（`> 0` 时界面要提示）。 */
  omitted: number;
  /** 真正要发出去的话：编辑后的文本，或原消息原文。 */
  text: string;
};

/**
 * 把「在这条消息处分叉」翻成一个种子。**纯函数**：不碰 React、不碰 IPC。
 *
 * 单独成文的理由是它同时决定了四件事的取值（目标 / 目录 / 模型 / 权限档）——
 * 任何一项取错，新会话都会在一个**看起来能跑**的语境里给出错误答案
 * （最典型：远端会话的上下文里全是远端路径，却在本机跑起来了）。
 */
export function makeForkSeed(input: {
  messages: CcMessage[];
  index: number;
  text: string;
  sourceSessionId: string | null;
  sourceTitle: string;
  connectionId: string;
  cwd: string;
  model: string;
  permissionMode: CcPermissionMode;
}): CcForkSeed {
  const { digest, omitted } = buildForkDigest(input.messages, input.index);
  return {
    sourceSessionId: input.sourceSessionId,
    sourceTitle: input.sourceTitle,
    connectionId: input.connectionId,
    cwd: input.cwd,
    model: input.model,
    permissionMode: input.permissionMode,
    digest,
    omitted,
    text: input.text.trim(),
  };
}

/** 摘要里一条消息的形态。工具调用 / 思考 / 审批不进摘要（理由见模块注释）。 */
type DigestLine = { role: "用户" | "助手"; body: string };

function flatten(raw: string): string {
  return raw.split(/\s+/).filter(Boolean).join(" ");
}

function clip(raw: string, max: number): string {
  const flat = flatten(raw);
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/**
 * 截断点之前的对话 → 纯文本摘要。
 *
 * `index` 是**要重跑的那条用户消息**在 `messages` 里的下标；它之后的全部丢弃，
 * 它自己也不进摘要（那句就是这次要发的内容，或者它的编辑版）。
 */
export function buildForkDigest(
  messages: CcMessage[],
  index: number,
): { digest: string; omitted: number } {
  const lines: DigestLine[] = [];
  for (const m of messages.slice(0, Math.max(0, index))) {
    if (m.kind === "user") lines.push({ role: "用户", body: clip(m.text, PER_MESSAGE_MAX) });
    else if (m.kind === "assistant")
      lines.push({ role: "助手", body: clip(m.text, PER_MESSAGE_MAX) });
  }
  const render = (l: DigestLine) => `【${l.role}】${l.body}`;

  // 从头丢：先整体拼一遍，超了就一条条去掉最前面的。
  let start = 0;
  let text = lines.map(render).join("\n\n");
  while (text.length > FORK_DIGEST_MAX && start < lines.length) {
    start += 1;
    text = lines.slice(start).map(render).join("\n\n");
  }
  // 只剩一条还超长（单条已按 PER_MESSAGE_MAX 截过，这里只防御性处理）。
  if (text.length > FORK_DIGEST_MAX) text = text.slice(-FORK_DIGEST_MAX);
  return { digest: text, omitted: start };
}

/**
 * 分叉那一轮真正发给 CLI 的文本。
 *
 * 没有前缀时**原样**发 `text`：从第一条消息处「分叉」等于「新开一条会话说同一句」，
 * 硬塞一段空的「以下是之前的对话」只会让模型困惑。
 */
export function buildForkPrompt(seed: Pick<CcForkSeed, "digest" | "omitted" | "text">): string {
  const body = seed.text.trim();
  if (!seed.digest.trim()) return body;
  const head =
    seed.omitted > 0
      ? `下面是我们之前对话的**后半段**（更早的 ${seed.omitted} 条已省略）。`
      : "下面是我们之前对话的内容。";
  return [
    "我们在接着一段已有对话继续（这是新的会话，你只看到下面这些文字，看不到当时的工具调用与文件改动）。",
    head,
    seed.digest,
    "---",
    "现在我重新表述我的要求：",
    body,
  ].join("\n\n");
}

/**
 * 侧栏排序：分叉出来的会话紧跟在它的来源后面。
 *
 * 「同组两个会话」不是靠分组头做的：一条会话可能被分叉多次，而分组头会把
 * 整个列表结构复杂化。挨着摆 + 行上一枚「分叉」标记，已经能一眼看出关系，
 * 而且不打断「按目标分组」这个更重要的结构。
 *
 * 找不到来源的（来源已被关掉并从列表消失）保持原位，不丢行。
 */
export function orderForks<T extends { key: string; forkOf?: string }>(rows: T[]): T[] {
  const out: T[] = [];
  const rest = new Map(rows.map((r) => [r.key, r]));
  const emit = (row: T, depth: number) => {
    if (!rest.has(row.key)) return; // 已经摆过
    rest.delete(row.key);
    out.push(row);
    if (depth > 8) return; // 防御：异常数据成环时不要把栈打断
    for (const child of rows) {
      if (child.forkOf === row.key) emit(child, depth + 1);
    }
  };
  for (const r of rows) {
    if (!r.forkOf || !rows.some((x) => x.key === r.forkOf)) emit(r, 0);
  }
  // 兜底：剩下的（理论上不该有）原序追加。
  for (const r of rows) if (rest.has(r.key)) out.push(r);
  return out;
}
