import { memo } from "react";
import type { CcApproval } from "../../lib/ccGuiTypes";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { useExpiryCountdown } from "../../hooks/useExpiryCountdown";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ApprovalDetail } from "./ApprovalDetail";
import { QuestionCard } from "./QuestionCard";
import { approvalCopyText } from "./summarize";

/**
 * 待批准卡片（`control_request{can_use_tool}` 的落地形态）。
 *
 * 三条硬要求，都来自协议事实而不是审美：
 * 1. **必须显示 `decision_reason`** —— 用户要知道"为什么问我"，否则只会条件反射按允许。
 * 2. **必须显示超时** —— CLI 侧 60s 到点自动拒绝，静默转圈会让人以为还在等。
 * 3. **允许/拒绝不做主次强调** —— 把「允许」画成主按钮等于引导放行，风险由界面承担。
 *
 * `AskUserQuestion` 不走这里：它要选项，不是放行。分派给 `QuestionCard`。
 */
function ApprovalCardImpl({
  approval,
  onAllow,
  onDeny,
  onAnswer,
}: {
  approval: CcApproval;
  onAllow: () => void;
  onDeny: () => void;
  /** 提问的答案：`{问题文本: [选项 label…]}`。普通审批不会调它。 */
  onAnswer: (answers: Record<string, string[]>) => void;
}) {
  // hooks 必须在「提问分流」那个早退**之前**：同一实例的 toolName 理论上不变，
  // 但 rules-of-hooks 只认调用顺序，不认「它实际上不会变」。
  const left = useExpiryCountdown(approval.expiresInSec);
  // 归零后 CLI 会撤回请求（卡片随之消失），这段空档里点按钮只会因后端找不到请求而报错。
  const expired = left === 0;
  const { copy, isCopied } = useCopyFeedback();
  // 提问一律走选项卡（哪怕一道题都没读出来 —— 那也有「跳过」这条路，
  // 而「允许」在协议上无法表达一个答案）。
  if (approval.toolName === "AskUserQuestion") {
    return <QuestionCard approval={approval} onSubmit={onAnswer} onSkip={onDeny} />;
  }
  const detail = approvalCopyText(approval.input);

  return (
    <div
      data-cc-entity
      role="group"
      aria-label={`等待批准：${approval.toolName}`}
      className="overflow-hidden rounded-[10px] border border-warning/45 bg-warning/[.06]"
    >
      <div className="flex items-center gap-2 border-b border-warning/25 px-3 py-[6px]">
        <Icon name="alertTriangle" size={12} className="shrink-0 text-warning-ink" />
        <span className="text-[12px] font-semibold text-warning-ink">等待批准</span>
        <span className="rounded-[4px] bg-warning/15 px-1.5 py-[1px] font-mono text-[11px] text-warning-ink">
          {approval.toolName}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-warning-ink/80">
          {expired ? "已超时，等待撤回" : `${left}s 后自动拒绝`}
        </span>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2">
        <ApprovalDetail
          toolName={approval.toolName}
          input={approval.input}
          copied={isCopied("detail")}
          onCopy={() => copy("detail", detail)}
        />
        <p className="flex items-start gap-1.5 text-[11px] leading-[1.5] text-warning-ink/90">
          <Icon name="info" size={11} className="mt-[3px] shrink-0" />
          {approval.reason}
        </p>
      </div>

      {/* gap-3：拒绝 / 允许并排且不做主次，间距太窄会在打字时顺手点错。 */}
      <div className="flex items-center justify-end gap-3 px-3 pb-2">
        <Button variant="outline" size="sm" className="h-7 px-3 text-[12px]" onClick={onDeny} disabled={expired}>
          拒绝
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-3 text-[12px]" onClick={onAllow} disabled={expired}>
          允许一次
        </Button>
      </div>
    </div>
  );
}

export const ApprovalCard = memo(ApprovalCardImpl);
