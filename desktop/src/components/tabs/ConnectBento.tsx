import type { ReactNode } from "react";
import type { StaticStatus } from "../../lib/types";
import { MetricSampler } from "./MetricSampler";
import { StatusCard } from "./StatusCard";
import { MetricCards } from "./MetricCards";
import { HealthCard } from "./HealthCard";
import { GovCard } from "./GovCard";

/**
 * 连接页 Bento 布局。取代旧的整幅 `ConnectHero`（已删）。
 *
 * 12 列网格的几何：
 * ```
 *   行1: [状态主卡 span4 ][指标1][指标2][指标3][指标4]   ← 4 + 2×4 = 12
 *   行2: [   同上（row span 2） ][ 健康度 span4 ][ 治理 span4 ]
 *   行3: [        接入 Claude Code（span 12）              ]
 * ```
 *
 * **为何将 live 数据下沉到各卡而不是在这里统一取**：只要本组件自己调 `useQuery`，
 * 它就会每 5s 重渲，连带整个子树（七张卡 + 接入向导）跟着重渲。所以本组件
 * **只拿 `StaticStatus`**（已剔除高频字段），它在配置未变时引用稳定，网格不重渲。
 * 采样则交给 `<MetricSampler />`——一个渲染 null 的叶子，它每 5s 重渲但不产生 DOM。
 */
export function ConnectBento({
  status,
  displayHost,
  port,
  onChanged,
  onNavigate,
  guide,
}: {
  status?: StaticStatus;
  displayHost: string;
  port: number;
  onChanged: () => void;
  /** 跨 Tab 跳转（可带锚点）。各卡点击后调它。 */
  onNavigate?: (tab: string, anchor?: string) => void;
  /** 「接入 Claude Code」卡。作为插槽传入，本组件不关心它的内部状态。 */
  guide: ReactNode;
}) {
  return (
    <div className="bento">
      {/* 采样器：渲染 null，不产生网格项，位置无关。
          放在最前面只为了读代码时先看到它。 */}
      <MetricSampler />

      {/* 下面所有卡片都是 `.bento` 的**直接子元素**，列跨度由 index.css 里的
          子选择器（`.bento > .status-card` 等）给。为何不包 wrapper div：
          `MetricCards` 返回 Fragment，它的四张卡必然是直接子元素；如果只给其他卡
          包 wrapper，两种结构混着来，高度拉伸（row span 2 时的 100% 高）就得写两套。 */}
      <StatusCard
        status={status}
        displayHost={displayHost}
        port={port}
        onChanged={onChanged}
        onNavigate={onNavigate}
      />
      <MetricCards status={status} onNavigate={onNavigate} />
      <HealthCard status={status} onNavigate={onNavigate} />
      <GovCard status={status} onNavigate={onNavigate} />

      {/* 接入向导是外部传入的 ReactNode，拿不到它的根 class，只能包一层。 */}
      <div className="bento-span12">{guide}</div>
    </div>
  );
}
