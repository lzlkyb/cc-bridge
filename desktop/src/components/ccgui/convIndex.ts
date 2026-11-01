import type { CcMessage } from "../../lib/ccGuiTypes";
import { markdownLeaves } from "../../lib/ccMarkdown";
import { plainOccurrences } from "../../lib/ccHighlight";
import { thinkingTitle, toolArgLabel, toolBodyText } from "./summarize";

/**
 * 会话内搜索的「可见文本」口径与命中收集（设计稿《对话页-会话内搜索》）。
 *
 * 一条消息 → 若干段，每段恰好对应渲染层的一个文本叶子（`CcMark.seg` 就是段下标）。
 * 🔴 段的取法必须与渲染处**逐字一致**：思考标题的 60 字截断、工具行的参数摘要、
 *    markdown 叶子切分 —— 渲染改一处，这里必须跟着改，否则出现「计数说命中、
 *    界面上找不到」的分裂。
 *
 * 从 `summarize.ts` 拆出（2026-11）：那个文件已经 300 行顶格，而这一段是
 * 「搜索索引」自己的关注点，与工具摘要 / 审批载荷不是一类东西。
 */

/** 一条消息的可见文本段。 */
export function convSegments(m: CcMessage): string[] {
  switch (m.kind) {
    case "user":
    case "assistant":
      // 两类气泡都走 MessageText（markdown 渲染），叶子切分同源。
      return markdownLeaves(m.text);
    case "thinking":
      return [thinkingTitle(m.text)];
    case "tool": {
      // 两段：seg 0 = 行上的参数摘要，seg 1 = 展开区正文（`toolBodyText`）。
      // 口径与 `ToolCard` 一一对应。此前只索引 seg 0，于是「那个报错在哪一轮」
      // 根本搜不到 —— 而那是最常搜的东西。
      // 空串也占位：seg 下标是渲染层的契约，塌掉一段会让后面的段整体前移。
      return [toolArgLabel(m.tool.input), toolBodyText(m.tool) ?? ""];
    }
    default:
      return []; // 审批 / 已裁决行不入搜索口径
  }
}

/** 一处命中：`msgId` + 段下标 + 段内字符区间。 */
export type ConvHit = { msgId: string; seg: number; start: number; end: number };

/**
 * 按文档顺序收集全部命中（大小写不敏感，foldSafe 见 `plainOccurrences`）。
 *
 * `segsOf` 可注入：调用方（`useCcConvSearch`）传一个**按消息引用缓存**的实现，
 * 这样流式期间只有正在增长的那一条会重跑 markdown 词法，其余整段会话直接命中
 * 缓存。不传则退回直接计算（测试与一次性调用用）。
 */
export function buildConvHits(
  messages: CcMessage[],
  query: string,
  segsOf: (m: CcMessage) => string[] = convSegments,
): ConvHit[] {
  const q = query.trim();
  if (!q) return [];
  const out: ConvHit[] = [];
  for (const m of messages) {
    const segs = segsOf(m);
    for (let s = 0; s < segs.length; s++) {
      for (const [start, end] of plainOccurrences(segs[s], q)) {
        out.push({ msgId: m.id, seg: s, start, end });
      }
    }
  }
  return out;
}
