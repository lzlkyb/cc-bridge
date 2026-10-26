import { useState } from "react";
import { revertKey } from "../../hooks/useCcApprovalAudit";
import type { ApprovalFileChange, ApprovalPoint } from "../../lib/ccApprovalAudit";
import { Icon, type IconName } from "../ui/icon";
import { ApprovalInlineDiff, hasInlineDiff, inlineNote } from "./ApprovalInlineDiff";

/**
 * 审批点里的**一个文件**一行：决定了哪一次改动、± 多少、能不能撤、
 * 以及（优化轨道 A）改了什么 —— 行首展开钮在行内摊开真实 diff。
 *
 * 🔴 展开态是**行级临时状态**（定案 4）：浮层关掉就忘，不记偏好。
 *    浮层是「看一眼改动」的轻动作，不是长期驻留的视图；把它做成全局记忆
 *    等于让下一次打开先替我决定一次「我要看细节」。
 */
export function ApprovalFileRow({
  point,
  file,
  verdict,
  busyKey,
  done,
  onRevert,
  onJump,
}: {
  point: ApprovalPoint;
  file: ApprovalFileChange;
  verdict: { icon: IconName; cls: string; title: string };
  busyKey: string | null;
  done: boolean;
  onRevert: (p: ApprovalPoint, f: ApprovalFileChange) => void;
  onJump: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const busy = busyKey === revertKey(point.key, file.path);
  const canRevert = file.revert !== "none" && !done;
  const expandable = hasInlineDiff(file);
  const note = inlineNote(file);

  return (
    <div
      className={`grid items-start gap-x-[7px] border-b border-border/60 px-3 py-[6px] last:border-0 ${
        expandable ? "grid-cols-[14px_1fr_auto_18px]" : "grid-cols-[14px_1fr_auto]"
      }`}
    >
      <span title={verdict.title} className="mt-[3px] shrink-0">
        <Icon name={verdict.icon} size={11} className={verdict.cls} />
      </span>
      <button
        type="button"
        onClick={() => point.jumpId && onJump(point.jumpId)}
        title={`${file.path}\n点击跳到流里那一次调用`}
        className="flex min-w-0 items-center gap-1.5 text-left"
      >
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {point.toolName}
        </span>
        <span className="min-w-0 truncate font-mono text-[12px] text-foreground">{file.label}</span>
        {file.added > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-success-ink">+{file.added}</span>
        )}
        {file.removed > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-destructive-ink">
            −{file.removed}
          </span>
        )}
        {/* 批量写只对第一个文件有内容，± 是它的；其余不显示数字而不是显示 0 */}
        {file.created && (
          <span className="shrink-0 rounded bg-success/12 px-1 text-[11px] text-success-ink">
            新建
          </span>
        )}
      </button>
      {done ? (
        <span className="flex items-center gap-1 text-[11px] text-success-ink">
          <Icon name="check" size={10} className="shrink-0" />
          已撤销
        </span>
      ) : file.revert !== "none" ? (
        <button
          type="button"
          onClick={() => onRevert(point, file)}
          disabled={!canRevert || busy}
          title={
            file.revert === "backup"
              ? "用审计里的备份还原到这次改动之前"
              : file.revert === "patch"
                ? "反向应用这次编辑（内容已变则整体拒绝）"
                : "删除这次新建的文件（内容被改过就不删）"
          }
          className="flex h-5 items-center gap-1 rounded border border-border px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-warning/50 hover:text-warning-ink disabled:opacity-40"
        >
          {busy ? (
            <Icon name="spinner" size={10} className="animate-spin" />
          ) : (
            <Icon name="restore" size={10} />
          )}
          撤销
        </button>
      ) : (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground/80">
          <Icon name="alertTriangle" size={10} className="shrink-0" />
          不可撤销
        </span>
      )}
      {expandable && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? "收起改动" : "展开改动内容"}
          aria-expanded={open}
          className="flex h-[18px] w-[18px] items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Icon
            name="chevronDown"
            size={11}
            className={`transition-transform ${open ? "" : "-rotate-90"}`}
          />
        </button>
      )}
      <div className="col-span-full min-w-0">
        {/* 不可撤销必须说清「为什么」—— 一个点了没反应的按钮比没有按钮更糟 */}
        {file.revert === "none" && file.reason && (
          <p className="mt-[2px] pl-[21px] text-[11px] leading-[1.55] text-muted-foreground">
            {file.reason}
          </p>
        )}
        {note && (
          <p className="mt-[2px] pl-[21px] text-[11px] leading-[1.55] text-muted-foreground">
            {note}
          </p>
        )}
        {open && (
          <div className="mt-1">
            <ApprovalInlineDiff file={file} />
          </div>
        )}
      </div>
    </div>
  );
}
