import type { StaticStatus } from "../../../lib/types";
import { Icon } from "../../ui/icon";

/* 风险总览（fix #10）：根据白名单 / 命令执行状态给出安全 or 风险摘要 */
export function RiskSummary({ status }: { status?: StaticStatus }) {
  if (!status) return null;
  const risks: string[] = [];
  if (!status.whitelistEnabled) risks.push("白名单已关闭");
  if (status.shellEnabled) risks.push("命令执行已开启");
  const safe = risks.length === 0;
  return (
    <div
      className={`risk-band mb-1 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${
        safe
          ? "border-success/30 bg-success/10 text-success"
          : "border-destructive/30 bg-destructive/10 text-destructive"
      }`}
    >
      <Icon name={safe ? "check" : "alertTriangle"} size={14} />
      {safe ? "所有安全开关处于推荐状态" : `当前风险：${risks.join(" · ")}`}
    </div>
  );
}
