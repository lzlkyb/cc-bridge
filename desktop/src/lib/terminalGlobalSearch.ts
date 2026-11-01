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

/** 匹配函数的状态：`ok` 可扫；`empty` 没关键词；`invalid` 正则半截。 */
type Matcher =
  | { kind: "ok"; test: (line: string) => boolean }
  | { kind: "empty" }
  | { kind: "invalid" };

/**
 * 造匹配函数。正则没写完（输入过程中的 `[`、`(`）时返回 `invalid`——不抛错（边敲边报错
 * 比没结果更烦人），但**必须让调用方能区分「真的没有匹配」和「这条表达式根本没扫」**：
 * 以前两者都表示成 `null`，面板于是对 `[` 显示「没有匹配的行」，用户以为历史里没有，
 * 与单标签查找的「模式非法」判定（`useTerminalSearch.isValidPattern`）也不一致。
 */
function makeMatcher(query: string, opts: SearchOptions): Matcher {
  if (!query) return { kind: "empty" };
  if (opts.regex) {
    try {
      // 不能带 g 标志：带 lastIndex 的 test 在逐行调用时会跳行。
      const re = new RegExp(query, opts.caseSensitive ? "" : "i");
      return { kind: "ok", test: (line) => re.test(line) };
    } catch {
      return { kind: "invalid" };
    }
  }
  if (opts.caseSensitive) return { kind: "ok", test: (line) => line.includes(query) };
  const lower = query.toLowerCase();
  return { kind: "ok", test: (line) => line.toLowerCase().includes(lower) };
}

/** 一次搜索的结果：命中 + 两个「别把沉默当结论」的标记。 */
export interface SearchReport {
  hits: GlobalHit[];
  /**
   * 命中数已达上限，**后面还有**（不是「只有这么多」）。判定要求真的多命中一条
   * （内部按 `limit + 1` 扫），否则「恰好 200 条」会被误报成被截断。
   */
  truncated: boolean;
  /** 开正则且表达式写不完整，本次一条都没扫。 */
  invalidPattern: boolean;
}

/**
 * 扫一个缓冲区，最多收录 `limit` 条，并额外多探一条用于判定 `truncated`。
 * 空行直接跳过（空白行不可能有意义的命中）。
 */
function scanBuffer(
  sessionId: string,
  buffer: IBuffer,
  test: (line: string) => boolean,
  limit: number,
): { hits: GlobalHit[]; overflow: boolean } {
  const hits: GlobalHit[] = [];
  if (limit <= 0) return { hits, overflow: true };
  // 多探一条：`limit + 1` 条命中就说明「还有」，正好 limit 条才是「就这么多」。
  const budget = limit + 1;
  const total = buffer.length;
  for (let i = 0; i < total; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (!text) continue;
    if (test(text)) {
      hits.push({ sessionId, line: i, text });
      if (hits.length >= budget) break;
    }
  }
  return { hits, overflow: hits.length > limit };
}

/** 扫一个缓冲区（结构化结果版）。 */
export function searchBufferReport(
  sessionId: string,
  buffer: IBuffer,
  query: string,
  opts: SearchOptions,
  limit: number = MAX_HITS,
): SearchReport {
  const m = makeMatcher(query, opts);
  if (m.kind !== "ok") {
    return { hits: [], truncated: false, invalidPattern: m.kind === "invalid" };
  }
  const { hits, overflow } = scanBuffer(sessionId, buffer, m.test, limit);
  return { hits: overflow ? hits.slice(0, limit) : hits, truncated: overflow, invalidPattern: false };
}

/** 扫一个缓冲区，最多返回 `limit` 条（只要命中列表）。 */
export function searchBuffer(
  sessionId: string,
  buffer: IBuffer,
  query: string,
  opts: SearchOptions,
  limit: number = MAX_HITS,
): GlobalHit[] {
  return searchBufferReport(sessionId, buffer, query, opts, limit).hits;
}

export interface SearchSource {
  sessionId: string;
  buffer: IBuffer;
}

/** 按会话顺序汇总（结构化结果版）；总命中数受 `limit` 约束（前几个会话可能就吃满额度）。 */
export function searchAllReport(
  sources: SearchSource[],
  query: string,
  opts: SearchOptions,
  limit: number = MAX_HITS,
): SearchReport {
  const m = makeMatcher(query, opts);
  if (m.kind !== "ok") {
    return { hits: [], truncated: false, invalidPattern: m.kind === "invalid" };
  }
  const hits: GlobalHit[] = [];
  for (const s of sources) {
    const remaining = limit - hits.length;
    if (remaining <= 0) {
      // 额度已用完：还要回答「后面到底有没有」。再多扫一条即可（不是全扫）。
      if (scanBuffer(s.sessionId, s.buffer, m.test, 1).hits.length > 0) {
        return { hits, truncated: true, invalidPattern: false };
      }
      continue;
    }
    const r = scanBuffer(s.sessionId, s.buffer, m.test, remaining);
    hits.push(...r.hits.slice(0, remaining));
    if (r.overflow) return { hits, truncated: true, invalidPattern: false };
  }
  return { hits, truncated: false, invalidPattern: false };
}

/** 按会话顺序汇总；总命中数受 `MAX_HITS` 约束（前几个会话可能就吃满额度）。 */
export function searchAll(
  sources: SearchSource[],
  query: string,
  opts: SearchOptions,
  limit: number = MAX_HITS,
): GlobalHit[] {
  return searchAllReport(sources, query, opts, limit).hits;
}
