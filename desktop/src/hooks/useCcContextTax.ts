import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import type { CcContextTax } from "../lib/ccContextTax";

/**
 * 一条会话的上下文构成（批 4-1）。
 *
 * ## 为什么只在打开时查、且不做轮询
 *
 * `audit.log` 是**追加写**的，缓存键是（路径, mtime, len）—— 只要有一轮流式事件
 * 在写日志，轮询就会**次次缓存未命中**、每 5 秒全量重解析整个日志文件。
 * 连接页那条 `read_recent_tail` 的头注释专门记过这个坑（那里按 5s 轮询把它变成了
 * 持续的 CPU 开销）。所以这里的策略是：**不轮询，只在两个确定时机各查一次** ——
 * 挂载（切到这条会话/打开页面）和「这一轮刚结束」。
 *
 * ## 为什么按 `running` 的 true→false 边沿刷新
 *
 * 一轮跑的过程中工具还在陆续落审计，数字一直在变；轮次结束后才稳定。
 * 用边沿而不是轮询，既拿到「刚跑完的最新值」，又不会在 TUI 静默时白扫日志。
 *
 * @param sessionId **CC 的** session id（`view.sessionId` = `system/init` 给的），
 *                  不是 cc-bridge 内部的 `meta.sessionId`。传错永远查到 0 条，
 *                  而且不报错，只是面板一片空白。
 * @param enabled   要不要查。**会话条传的是恒 `true`** —— 面板关着也要查，因为
 *                  余量条上的降级警示点必须在用户没点开时就能看见。只在「确定
 *                  没有 sessionId」时才关（那时 queryFn 本来也会直接返回 null）。
 * @param running   这一轮是否正在跑（用来抓结束边沿）。
 */
export function useCcContextTax(
  sessionId: string | null,
  enabled: boolean,
  running: boolean,
) {
  const q = useQuery<CcContextTax | null, Error>({
    queryKey: ["cc-context-tax", sessionId],
    queryFn: async () => {
      // 没有 sessionId 就不发请求：新会话还没 `Init`，后端按空 id 也会直接返回空结构，
      // 但白跑一次 IPC 没有意义。
      if (!sessionId) return null;
      return invoke<CcContextTax>("cc_context_tax", { sessionId });
    },
    // 🔴 `enabled` 同时管住「面板关着」和「没有 id」两种情况：关着时连 stale 判断都不做。
    enabled: enabled && !!sessionId,
    // 每次打开都重查（0 = 立刻 stale）：用户点开就是想看**现在**的构成，
    // 给一份 30 秒前的缓存数字会让他对着过期的账怀疑功能坏了。
    staleTime: 0,
    // 关掉 react-query 的窗口聚焦重查：这个面板已经被「打开」与「轮次结束」两个
    // 时机精确覆盖，再加一层聚焦重查纯属多扫日志。
    refetchOnWindowFocus: false,
    retry: false,
  });

  // 轮次结束的边沿：上一次 running 为真、这一次为假 ⇒ 工具都落完审计了，补一刀。
  // `refetch` 是 react-query 给的稳定引用（不进依赖也不会漏更新，但要写全 lint 才过）。
  const wasRunning = useRef(running);
  const refetch = q.refetch;
  useEffect(() => {
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (ended && enabled) void refetch();
  }, [running, enabled, refetch]);

  return q;
}
