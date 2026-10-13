import type { HTMLAttributes } from "react";
import { Icon } from "./icon";
import { riskLevel, type SecurityFlags } from "../../lib/riskLevel";

/**
 * 风险总览带（三档：较安全 / 有风险 / 高风险）。
 *
 * 安全页与设置页共用这一个展示组件，判定全部来自 lib/riskLevel.ts——
 * 消除历史上「同一状态两页结论相反」的分叉（readonly+shell 同开时设置页显红、
 * 安全页显绿）。替换掉原 settings/RiskSummary.tsx（两态）与
 * SecurityOverview.tsx 内部的局部 RiskSummary（三态私有实现）。
 */
export function RiskBand({
  status,
  className = "",
  ...props
}: { status?: SecurityFlags } & HTMLAttributes<HTMLDivElement>) {
  if (!status) return null;
  const v = riskLevel(status);
  return (
    <div
      className={`risk-band mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-xs font-medium ${v.pill} ${className}`}
      {...props}
    >
      <Icon name={v.icon} size={14} />
      <span className="text-muted-foreground">当前风险等级：</span>
      <span className="inline-flex items-center rounded-full border px-2 py-0.5 font-semibold">
        {v.label}
      </span>
      <span className="text-muted-foreground">{v.desc}</span>
    </div>
  );
}
