import { memo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { StaticStatus } from "../../lib/types";
import type { CcApproval } from "../../lib/ccGuiTypes";
import { appendRule } from "../../lib/ccAutoApprove";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { useExpiryCountdown } from "../../hooks/useExpiryCountdown";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
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
  // 「以后都放行这类」要读现有规则表（追加而不是覆盖）。与 App 共用 ["status"]
  // 缓存，命中时一个请求都不发。
  const qc = useQueryClient();
  const { data: status } = useQuery<StaticStatus>({
    queryKey: ["status"],
    queryFn: () => invoke<StaticStatus>("get_status"),
  });
  const [remembering, setRemembering] = useState(false);
  const rememberRef = useRef(false);
  // 提问一律走选项卡（哪怕一道题都没读出来 —— 那也有「跳过」这条路，
  // 而「允许」在协议上无法表达一个答案）。
  if (approval.toolName === "AskUserQuestion") {
    return <QuestionCard approval={approval} onSubmit={onAnswer} onSkip={onDeny} />;
  }
  const detail = approvalCopyText(approval.input);

  /**
   * 「以后都放行这类」：把这次调用加成一条规则，并放行这一次。
   *
   * 🔴 规则文本由 Rust 拼（`cc_approval_rule`）。前端拼的话 glob 转义一旦做错，
   *    生成的规则会比界面上那行字**更宽**（`ls *.rs` 里的 `*` 能跨空格），
   *    而用户看到的正是「以后都放行 `ls *.rs`」—— 没人会去核对星号。
   */
  const remember = async () => {
    if (rememberRef.current) return;
    rememberRef.current = true;
    setRemembering(true);
    try {
      const rule = await invoke<string | null>("cc_approval_rule", {
        toolName: approval.toolName,
        input: approval.input,
      });
      if (!rule) {
        toast("这条调用取不到主参数，生成不了窄规则 —— 要全放行请去设置页手写", "info");
        return;
      }
      /**
       * 🔴 规则表必须**读到了**才动。`status` 还没回来（或 `get_status` 失败）时
       *    `?? []` 会当成「用户一条规则都没有」，`save_config` 是整字段覆盖 ⇒
       *    点一下「以后都放行」就把用户手写的全部规则清成只剩这一条，
       *    而且没有任何地方能看出来发生过 —— 这里宁可让人多点一次。
       */
      const rules = status?.ccAutoApproveRules;
      if (!rules) {
        toast("配置还没读出来，稍等一下再点（现在写会覆盖掉已有规则）", "warning");
        return;
      }
      const { next, changed } = appendRule(rules, rule);
      if (changed) {
        await invoke("save_config", { patch: { ccAutoApproveRules: next } });
        await qc.invalidateQueries({ queryKey: ["status"] });
        toast(`以后都放行：${rule}（设置页可撤销）`, "info");
      } else {
        toast(`这条规则已经有了：${rule}`, "info");
      }
      // 规则已在（或刚加上），这一次自然也是放行 —— 按钮说的是「以后都放行」，
      // 不该再让人回来补点一次「允许一次」。
      onAllow();
    } catch (e) {
      toast(`加规则失败：${e}`, "error");
    } finally {
      rememberRef.current = false;
      setRemembering(false);
    }
  };

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

      {/* gap-2 + flex-wrap：三个按钮在 320px 最窄卡里排不下，换行比挤成一团好。
          「以后都放行」用 ghost + 淡字色：它不是推荐项（见文件头第 3 条），
          只是「这条命令我一天要点十遍」时才该走的路。 */}
      <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-2">
        <Button variant="outline" size="sm" className="h-7 px-3 text-[12px]" onClick={onDeny} disabled={expired}>
          拒绝
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[12px] text-muted-foreground"
          onClick={() => void remember()}
          disabled={expired || remembering}
          title="把这次的工具与参数加成一条自动放行规则（规则文本显示在提示里，设置页可撤销）"
        >
          {remembering ? "正在加…" : "以后都放行"}
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-3 text-[12px]" onClick={onAllow} disabled={expired}>
          允许一次
        </Button>
      </div>
    </div>
  );
}

export const ApprovalCard = memo(ApprovalCardImpl);
