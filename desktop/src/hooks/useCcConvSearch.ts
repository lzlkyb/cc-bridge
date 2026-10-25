import { useCallback, useEffect, useMemo, useState } from "react";
import type { CcMessage } from "../lib/ccGuiTypes";
import type { CcMark } from "../lib/ccMarkdown";
import { buildConvHits } from "../components/ccgui/summarize";

/**
 * 会话内搜索的状态层（设计稿《对话页-会话内搜索》）。
 *
 * 索引口径在 `summarize.convSegments`（与渲染层逐字一致），命中收集在
 * `buildConvHits`（纯函数，单测在那边）。这里只做三件事：
 * - 开关 / 查询串 / 当前命中序号三个状态；
 * - `marksByMsg`：把平铺命中按消息分组并标出「当前命中」（渲染层只认它）；
 * - 流式增长时命中数变化，序号自动收敛到界内（新内容进来重算，
 *   当前命中仍存在则位置不动，否则落到最后一条界内命中）。
 *
 * 挂在 `ConversationStream`（每个 pane 一份）：多 pane 各自独立搜索。
 */
export function useCcConvSearch(messages: CcMessage[]) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [occ, setOcc] = useState(0);

  const hits = useMemo(() => (open ? buildConvHits(messages, query) : []), [open, messages, query]);

  // 命中收缩（查询变了 / 新内容把文本顶没了）时把序号收回界内。
  useEffect(() => {
    setOcc((o) => (o > hits.length - 1 ? Math.max(0, hits.length - 1) : o));
  }, [hits.length]);

  const occIn = hits.length > 0 ? Math.min(occ, hits.length - 1) : 0;
  const current = hits.length > 0 ? hits[occIn] : null;

  const marksByMsg = useMemo(() => {
    if (!current) return null;
    const map = new Map<string, CcMark[]>();
    for (const h of hits) {
      const mark: CcMark = { seg: h.seg, start: h.start, end: h.end, current: h === current };
      const list = map.get(h.msgId);
      if (list) list.push(mark);
      else map.set(h.msgId, [mark]);
    }
    return map;
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

  return { open, query, changeQuery, hits, occ: occIn, next, prev, openSearch, close, marksByMsg };
}
