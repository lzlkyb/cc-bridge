import { useMemo } from "react";
import { Icon } from "../ui/icon";
import { DiffBlock } from "./DiffBlock";
import { approvalPayload } from "./summarize";

/**
 * 审批卡里的「这次到底改什么」。
 *
 * 审批是这个产品的护城河，所以这里的第一原则是**让人真的看懂再决定**：
 * 文件改动给 diff、命令给命令、其余才退到 JSON。转义后的 `\n` 字面量不是 diff，
 * 拿它当审批依据等于让人盲批。
 *
 * 🔴 diff 一律**恒单栏**（`layout="unified"`）：审批卡最窄会落到 320px 窗口里，
 *    井排每栏只剩一百多像素，等宽 12px 五六个字符就折行。
 *
 * 🔴 复制按钮**不进**滚动容器：`overflow-auto` 会把绝对定位的按钮一起裁掉
 *    （一个轴非 visible，另一个轴也变 auto），这是本项目踩过的老坑。
 */
export function ApprovalDetail({
  toolName,
  input,
  copied,
  onCopy,
}: {
  toolName: string;
  input: Record<string, unknown>;
  copied: boolean;
  onCopy: () => void;
}) {
  const payload = useMemo(() => approvalPayload(toolName, input), [toolName, input]);

  const copyButton = (float: boolean) => (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "已复制" : "复制完整入参"}
      aria-label="复制审批详情"
      aria-live="polite"
      className={`flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded border border-border bg-card/90 px-1.5 text-[11px] text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 ${
        float ? "absolute right-1.5 top-1.5 opacity-0 group-hover/detail:opacity-100" : ""
      }`}
    >
      <Icon name={copied ? "check" : "copy"} size={10} />
    </button>
  );

  if (payload.kind === "diff") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground"
            title={payload.path}
          >
            {payload.path}
          </span>
          {copyButton(false)}
        </div>
        <div className="max-h-[240px] overflow-auto">
          <DiffBlock
            oldText={payload.oldText}
            newText={payload.newText}
            edits={payload.edits}
            layout="unified"
          />
        </div>
        {payload.note && (
          <p className="text-[11px] leading-[1.5] text-warning-ink/80">{payload.note}</p>
        )}
      </div>
    );
  }

  return (
    <div className="group/detail relative">
      <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap break-words border-l-2 border-warning/40 bg-warning/[.04] px-2.5 py-1.5 pr-12 font-mono text-[12px] leading-[1.6] text-foreground">
        {payload.text}
      </pre>
      {copyButton(true)}
    </div>
  );
}
