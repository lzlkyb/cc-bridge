import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import type { CcStoredSummary } from "../lib/ccEventTypes";
import { STORED_SESSIONS_KEY } from "./useCcPaneList";

/** 一次取多少条。与后端 `DEFAULT_STORED_LIMIT` 同一个数（那边是兜底，这里显式给）。 */
export const STORED_LIMIT = 30;

/**
 * 库里落盘过的会话（侧栏「历史」区）。
 *
 * ## 为什么要 `staleTime`
 *
 * 这份数据只在「某条会话落盘 / 被关掉」时变，而那两件事都由我们自己触发
 * （`close` 里 `invalidateQueries`）。不给 `staleTime` 的话，每次窗口重新聚焦
 * （react-query 默认行为）都会重取一遍 —— 一次 SELECT 三十行摘要虽然不贵，
 * 但侧栏会跟着闪一下「加载中」，没必要。
 *
 * ## 为什么失败不弹错
 *
 * 历史区是**可选内容**：读不出来就当没有（`data` 为 `undefined`，列表不渲染），
 * 当前会话完全不受影响。为它弹一条错误只会让用户以为对话坏了。
 */
export function useCcStoredSessions() {
  return useQuery<CcStoredSummary[], Error>({
    queryKey: STORED_SESSIONS_KEY,
    queryFn: () => invoke<CcStoredSummary[]>("cc_list_stored", { limit: STORED_LIMIT }),
    staleTime: 30_000,
  });
}
