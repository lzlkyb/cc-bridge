import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CcMessage } from "../lib/ccGuiTypes";
import type { CcMark } from "../lib/ccMarkdown";
import { buildConvHits, convSegments } from "../components/ccgui/convIndex";

/**
 * 会话内搜索的状态层（设计稿《对话页-会话内搜索》）。
 *
 * 索引口径在 `convIndex.convSegments`（与渲染层逐字一致），命中收集在
 * `buildConvHits`（纯函数）。这里多做两件**性能**上的事 —— 2026-11 审查 P1-3：
 *
 * 1. **按消息引用缓存分段**：`convSegments` 对整条正文跑一次 markdown 词法。
 *    流式期间 `messages` 每 tick 都是新数组，但只有最后一条的对象引用会变
 *    （reducer 是不可变更新）⇒ 用 `Map<msgId, {msg, segs}>` 做引用比较，
 *    整段会话只在第一次搜索时付词法成本。
 * 2. **命中结果节流**：只有在「搜索打开 + 有查询词」时才建索引，且 messages
 *    变化时最多每 300ms 重算一次（查询词变化立即生效 —— 那是用户在打字，
 *    不能等）。否则流式 60ms 一批会把整段会话的索引重算十几遍/秒。
 *
 * 🔴 不做「增量命中累加」：命中区间是全文档顺序的，追加消息会让总序号变化，
 *    增量维护的复杂度远高于重算（有缓存之后重算是 O(命中数)）。
 */
const REINDEX_MS = 300;

export function useCcConvSearch(messages: CcMessage[]) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [occ, setOcc] = useState(0);

  /** 引用缓存：内容没变的消息不重跑 markdown 词法。 */
  const segCache = useRef(new Map<string, { msg: CcMessage; segs: string[] }>());
  const segsOf = useCallback((m: CcMessage): string[] => {
    const cur = segCache.current.get(m.id);
    // 🔴 reducer 是不可变更新：同一条消息对象引用不变 ⇒ 内容一定没变。
    if (cur && cur.msg === m) return cur.segs;
    const segs = convSegments(m);
    segCache.current.set(m.id, { msg: m, segs });
    return segs;
  }, []);

  /** 节流后的输入（只用于建索引；`messages` 本身仍然每 tick 更新给渲染层）。 */
  const [indexed, setIndexed] = useState<CcMessage[]>(messages);
  const lastRun = useRef(0);
  useEffect(() => {
    // 没打开搜索就完全不建索引：索引唯一的用途是给搜索条，关着时每 tick 重算纯浪费。
    if (!open) return;
    const wait = Math.max(0, REINDEX_MS - (Date.now() - lastRun.current));
    const timer = window.setTimeout(() => {
      lastRun.current = Date.now();
      setIndexed(messages);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [messages, open]);

  const hits = useMemo(
    () => (open ? buildConvHits(indexed, query, segsOf) : []),
    [open, indexed, query, segsOf],
  );

  // 命中收缩（查询变了 / 新内容把文本顶没了）时把序号收回界内。
  useEffect(() => {
    setOcc((o) => (o > hits.length - 1 ? Math.max(0, hits.length - 1) : o));
  }, [hits.length]);

  const occIn = hits.length > 0 ? Math.min(occ, hits.length - 1) : 0;
  const current = hits.length > 0 ? hits[occIn] : null;

  /**
   * `marksByMsg`：命中按消息分组，标出「当前命中」。
   *
   * 🔴 必须**逐消息复用数组引用**：这个 Map 是每条消息的 `marks` prop 来源，
   *    一旦整个 Map 换新、每个数组换新，`MessageText` / `ToolCard` /
   *    `UserMessageBubble` 的 memo 全部失效 —— 本来只为流式那一条付的钱，
   *    变成整棵树付。所以内容没变的消息沿用上一次的数组。
   */
  const prevMarks = useRef(new Map<string, CcMark[]>());
  const marksByMsg = useMemo(() => {
    const next = new Map<string, CcMark[]>();
    const same = (a: CcMark[] | undefined, b: CcMark[]) =>
      !!a &&
      a.length === b.length &&
      a.every((m, i) => m.seg === b[i].seg && m.start === b[i].start && m.end === b[i].end && !!m.current === !!b[i].current);
    if (current) {
      for (const h of hits) {
        const mark: CcMark = { seg: h.seg, start: h.start, end: h.end, current: h === current };
        const list = next.get(h.msgId);
        if (list) list.push(mark);
        else next.set(h.msgId, [mark]);
      }
      for (const [id, list] of next) {
        const prev = prevMarks.current.get(id);
        if (same(prev, list)) next.set(id, prev as CcMark[]);
      }
    }
    prevMarks.current = next;
    return next.size > 0 ? next : null;
  }, [hits, current]);

  const changeQuery = useCallback((q: string) => {
    setQuery(q);
    setOcc(0);
  }, []);
  const next = useCallback(() => setOcc((o) => (hits.length ? (o + 1) % hits.length : 0)), [hits.length]);
  const prev = useCallback(() => setOcc((o) => (hits.length ? (o - 1 + hits.length) % hits.length : 0)), [hits.length]);
  // 关闭只收浮层与高亮：查询串留在 state 里，重开时还在（终端搜索条同款行为）。
  const openSearch = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  return {
    open,
    query,
    changeQuery,
    hits,
    occ: occIn,
    next,
    prev,
    openSearch,
    close,
    marksByMsg,
  };
}
