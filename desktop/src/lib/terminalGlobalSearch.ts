import type { IBuffer } from "@xterm/xterm";

/**
 * 跨标签搜索：一次扫过所有会话的缓冲区。
 *
 * WHY 不用 `SearchAddon`：它挂在**单个** Terminal 实例上（装饰、滚动、命中数都在
 * 那个实例内部），跨实例搜索拿不到统一结果，还得先切标签才能搜——那就不是跨标签了。
 * 这里退到最朴素的做法：逐行 `translateToString(true)` + 自己匹配。
 *
 * 代价可控：滚动历史 5000 行 × 会话数，一次全扫是毫秒级；只在展开面板/改条件时扫
 * （见 `TerminalGlobalSearch.tsx` 的 debounce），不做增量。
 *
 * 命中的行号是**缓冲区绝对行号**（含 scrollback），可以直接喂 `scrollToLine`。
 */

export interface GlobalHit {
  sessionId: string;
  /** 缓冲区绝对行号（0 = 缓冲区第一行，不是屏幕第一行）。 */
  line: number;
  /** 该行文本（已按终端列宽修剪行尾空白）。 */
  text: string;
}

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

/**
 * 单次搜索最多返回多少条。上限存在的理由是**渲染**：结果是 React 列表，
 * 关键词命中上千行时全渲染会明显卡（而用户不可能真的去翻第 300 条）。
 */
export const MAX_HITS = 200;

/**
 * 造匹配函数。正则没写完（输入过程中的 `[`、`(`）时返回 null——不抛错、不弹提示，
 * 就当没匹配，否则边敲边报错比没结果更烦人。
 */
function makeMatcher(query: string, opts: SearchOptions): ((line: string) => boolean) | null {
  if (!query) return null;
  if (opts.regex) {
    try {
      // 不能带 g 标志：带 lastIndex 的 test 在逐行调用时会跳行。
      const re = new RegExp(query, opts.caseSensitive ? "" : "i");
      return (line) => re.test(line);
    } catch {
      return null;
    }
  }
  if (opts.caseSensitive) return (line) => line.includes(query);
  const lower = query.toLowerCase();
  return (line) => line.toLowerCase().includes(lower);
}

/** 扫一个缓冲区，最多返回 `limit` 条。空行直接跳过（空白行不可能有意义的命中）。 */
export function searchBuffer(
  sessionId: string,
  buffer: IBuffer,
  query: string,
  opts: SearchOptions,
  limit: number = MAX_HITS,
): GlobalHit[] {
  const test = makeMatcher(query, opts);
  if (!test || limit <= 0) return [];
  const hits: GlobalHit[] = [];
  const total = buffer.length;
  for (let i = 0; i < total; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (!text) continue;
    if (test(text)) {
      hits.push({ sessionId, line: i, text });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

export interface SearchSource {
  sessionId: string;
  buffer: IBuffer;
}

/** 按会话顺序汇总；总命中数受 `MAX_HITS` 约束（前几个会话可能就吃满额度）。 */
export function searchAll(
  sources: SearchSource[],
  query: string,
  opts: SearchOptions,
  limit: number = MAX_HITS,
): GlobalHit[] {
  const out: GlobalHit[] = [];
  for (const s of sources) {
    if (out.length >= limit) break;
    out.push(...searchBuffer(s.sessionId, s.buffer, query, opts, limit - out.length));
  }
  return out;
}
