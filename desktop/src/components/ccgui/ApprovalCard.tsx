import { memo } from "react";
import type { CcApproval } from "../../lib/ccGuiTypes";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { asString } from "./summarize";

/**
 * 待批准卡片（`control_request{can_use_tool}` 的落地形态）。
 *
 * 三条硬要求，都来自协议事实而不是审美：
 * 1. **必须显示 `decision_reason`** —— 用户要知道"为什么问我"，否则只会条件反射按允许。
 * 2. **必须显示超时** —— CLI 侧 60s 到点自动拒绝，静默转圈会让人以为还在等。
 * 3. **允许/拒绝不做主次强调** —— 把「允许」画成主按钮等于引导放行，风险由界面承担。
 */
function ApprovalCardImpl({
  approval,
  onAllow,
  onDeny,
}: {
  approval: CcApproval;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const command = asString(approval.input.command);
  const detail = command || JSON.stringify(approval.input, null, 2);

  return (
    <div data-cc-entity className="overflow-hidden rounded-[10px] border border-warning/45 bg-warning/[.06]">
      <div className="flex items-center gap-2 border-b border-warning/25 px-3 py-[6px]">
        <Icon name="alertTriangle" size={12} className="shrink-0 text-warning-ink" />
        <span className="text-[12px] font-semibold text-warning-ink">等待批准</span>
        <span className="rounded-[4px] bg-warning/15 px-1.5 py-[1px] font-mono text-[11px] text-warning-ink">
          {approval.toolName}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-warning-ink/80">
          {approval.expiresInSec}s 后自动拒绝
        </span>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2">
        <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap break-words border-l-2 border-warning/40 bg-warning/[.04] px-2.5 py-1.5 font-mono text-[12px] leading-[1.6] text-foreground">
          {detail}
        </pre>
        <p className="flex items-start gap-1.5 text-[11px] leading-[1.5] text-warning-ink/90">
          <Icon name="info" size={11} className="mt-[3px] shrink-0" />
          {approval.reason}
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 px-3 pb-2">
        <Button variant="outline" size="sm" className="h-7 px-3 text-[12px]" onClick={onDeny}>
          拒绝
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-3 text-[12px]" onClick={onAllow}>
          允许一次
        </Button>
      </div>
    </div>
  );
}

export const ApprovalCard = memo(ApprovalCardImpl);
