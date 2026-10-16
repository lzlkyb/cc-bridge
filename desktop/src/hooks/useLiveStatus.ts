/**
 * 订阅 status 查询里的「高频字段」（`uptimeSeconds` / `stats`）。
 *
 * WHY 单独成 hook：Bento 行2 的三张卡（StatusCard / MetricCards / HealthCard）加
 * 采样器 MetricSampler 都需要同一份 live 字段，四处各写一遍 `useQuery` 意味着
 * queryKey / queryFn / select 三行逐字重复。
 *
 * 🔴 分层的意义在于「谁高频、谁订阅」：静态字段留在 App 层（引用稳定，下游
 * `memo(Header)` / `memo(ConnectTab)` 才真正生效），高频字段由需要它的叶子自订阅。
 *
 * 🔴 不设 `refetchInterval`：轮询的**唯一主人**是 App 层（`App.tsx`），本 hook 只
 * 共享同一 queryKey 的缓存，**不会多发请求**。窗口不可见时 App 层停轮询，这里自然
 * 也停——`MetricSampler` 的断层采样逻辑正依赖这一点。
 */
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import type { LiveStatus, StatusResponse } from "../lib/types";

/** 从完整 status 里剔出高频字段（与 App 层取 `StaticStatus` 的 select 互补）。 */
export function selectLiveStatus(s: StatusResponse): LiveStatus {
  return { uptimeSeconds: s.uptimeSeconds, stats: s.stats };
}

/**
 * live 字段订阅。除 `data` 外还要用 `dataUpdatedAt` 的调用方（采样器）直接取用：
 * `stats` 会被 react-query 的 structural sharing 保持旧引用，**不能拿它当 effect 依赖**。
 */
export function useLiveStatus() {
  return useQuery<StatusResponse, Error, LiveStatus>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    select: selectLiveStatus,
  });
}
