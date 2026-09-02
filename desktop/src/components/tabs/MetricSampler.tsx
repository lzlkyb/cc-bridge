import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, LiveStatus } from "../../lib/types";
import { pushSample } from "../../lib/metricHistory";

/**
 * 指标采样器。**渲染 null**，只负责把每次 status 轮询的结果推进
 * `metricHistory` 环形缓冲，供四张指标卡画 sparkline。
 *
 * 🔴 **为何要单独做成一个组件，而不是写在 Bento 容器里**：
 * 只要容器自己调 `useQuery`，它就会每 5s 重渲一次——连带**整个 Bento 子树**
 * （状态主卡 + 4 张指标卡 + 健康环 + 治理卡 + 接入向导）跟着重渲。
 * 把订阅关在这个空叶子里，重渲染就被隔离在一个不产生任何 DOM 的组件内。
 * 这与 `ConnectHero` 把 live 字段下沉到自身订阅是同一个理由。
 *
 * **不新增轮询**：复用 App 层已有的 `["status"]` 缓存与轮询，本组件不设
 * `refetchInterval`。窗口不可见时 App 层停轮询 → 本处自然也停采样，
 * 重新可见后的首次采样会被 `pushSample` 当作断层处理（清空重来）。
 */
export function MetricSampler() {
  const { data, dataUpdatedAt } = useQuery<StatusResponse, Error, LiveStatus>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    select: (s) => ({ uptimeSeconds: s.uptimeSeconds, stats: s.stats }),
  });

  // stats 放 ref：effect 不能以它为依赖（原因见下），但回调里要读到最新值。
  const statsRef = useRef(data?.stats);
  statsRef.current = data?.stats;

  useEffect(() => {
    const stats = statsRef.current;
    if (!stats) return;
    // Date.now() 在这里取，而不是在 pushSample 内部：那边要能被单测控制时间推进。
    pushSample(stats, Date.now());
    // 🔴 **依赖必须是 `dataUpdatedAt` 而不是 `stats`**。
    //
    // react-query 对 `select` 的输出也做 structural sharing：空闲时后端 stats
    // 完全不变（requestsPerMin 归 0 后一直是 0、activeCommands 0、totalRequests 不动），
    // 深度相等 → **嵌套的 stats 保持旧引用** → 以它为依赖的 effect 永不触发 → 不采样。
    // （外层 data 确实每次都变，因为 uptimeSeconds 在涨，但那救不了嵌套字段。）
    //
    // 后果是双重的：不仅空闲时停采样，而且 lastAt 停在很久以前，
    // 等远程终于调用一次、stats 变了，pushSample 一看 gap > MAX_GAP_MS → 当作断层
    // 清空重来 → 又空闲 → 又停。结果是**永远攒不到 2 个点，四张卡大半时间卡在“采样中…”**。
    //
    // `dataUpdatedAt` 是每次 fetch 成功的时间戳，**数据相同也会更新**，
    // 正好把“每 5s 采一次”这个节拍归一回时间而不是变化。
     
  }, [dataUpdatedAt]);

  return null;
}
