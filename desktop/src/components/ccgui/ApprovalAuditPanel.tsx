import { useEffect, useRef } from "react";

import { isOutsideDismiss } from "../../lib/utils";
import { revertKey } from "../../hooks/useCcApprovalAudit";
import type { ApprovalFileChange, ApprovalGroup, ApprovalPoint } from "../../lib/ccApprovalAudit";
import { Icon, type IconName } from "../ui/icon";
import { ApprovalFileRow } from "./ApprovalFileRow";

/**
 * 「本会话改动」浮层（批 4-2）：按**审批点**分组，不是按文件聚合。
 *
 * 与批 2-3 那个按文件列表的区别是它回答的问题：
 * 那边问「改过哪些文件」，这边问「**我点的那一下**改了什么、能不能撤回」。
 * 同一个文件被改三次，这边是三个点、三次独立的撤销。
 *
 * 沿用同排浮层的材质（`bg-card` + `shadow-xl`），宽度 400 → 440：
 * 一行要放 [决定][工具][路径][±][撤销] 五段，400 会挤到换行。
 * 浮层 `absolute` 不占布局 —— 占高度会把消息区顶跳（同 HistoryPanel 的理由）。
 */

/** 决定 → 图标 + 颜色 + 说明。区分「自动放行」与「我点的允许」，那是两件事。 */
function verdictOf(p: ApprovalPoint): { icon: IconName; cls: string; title: string } {
  switch (p.decision) {
    case "allow":
      return p.auto
        ? { icon: "sparkles", cls: "text-primary", title: "审批规则命中，自动放行" }
        : { icon: "check", cls: "text-success-ink", title: "你允许了这次调用" };
    case "deny":
      return { icon: "close", cls: "text-muted-foreground", title: "你拒绝了这次调用，它没有执行" };
    case "pending":
      return { icon: "spinner", cls: "text-warning-ink", title: "还在等你决定" };
    default:
      // 历史转录里没有审批事件（审批是交互协议，不落 .jsonl）。
      return { icon: "info", cls: "text-muted-foreground", title: "历史记录里没有审批信息" };
  }
}

function Row({
  point,
  busyKey,
  reverted,
  onRevert,
  onJump,
}: {
  point: ApprovalPoint;
  busyKey: string | null;
  reverted: Record<string, true>;
  onRevert: (p: ApprovalPoint, f: ApprovalFileChange) => void;
  onJump: (id: string) => void;
}) {
  const v = verdictOf(point);
  const denied = point.decision === "deny";

  // 没有文件点（拒绝 / 未决）：只有一行，右侧写明状态。
  if (point.files.length === 0) {
    return (
      <div
        className={`flex items-center gap-2 border-b border-border/60 px-3 py-[6px] last:border-0 ${
          denied ? "opacity-60" : ""
        }`}
      >
        {/* SVG 的 `title` 属性不弹 tooltip（要 `<title>` 子元素），包一层 span 才有 */}
        <span title={v.title} className="mt-[3px] shrink-0">
          <Icon name={v.icon} size={11} className={v.cls} />
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{point.toolName}</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
          {point.note}
        </span>
      </div>
    );
  }

  return (
    <>
      {point.files.map((f) => {
        const key = revertKey(point.key, f.path);
        return (
          <ApprovalFileRow
            key={key}
            point={point}
            file={f}
            verdict={v}
            busyKey={busyKey}
            done={reverted[key] === true}
            onRevert={onRevert}
            onJump={onJump}
          />
        );
      })}
    </>
  );
}

export function ApprovalAuditPanel({
  groups,
  stat,
  reverted,
  busyKey,
  onRevertOne,
  onRevertGroup,
  onJump,
  onClose,
}: {
  groups: ApprovalGroup[];
  stat: { points: number; files: number; revertable: number; denied: number };
  reverted: Record<string, true>;
  busyKey: string | null;
  onRevertOne: (p: ApprovalPoint, f: ApprovalFileChange) => void;
  onRevertGroup: (g: ApprovalGroup) => void;
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  // 点外面关 + Esc 关。开关按钮自身不算外点（`isOutsideDismiss` 的理由写在那边）。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (isOutsideDismiss(e, boxRef.current, "changeset")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="本会话改动"
      className="absolute right-0 top-full z-30 mt-1 flex max-h-[520px] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="file" size={12} className="shrink-0 opacity-70" />
        <span className="text-[12px] font-semibold text-foreground">本会话改动</span>
        <span className="text-[11px] text-muted-foreground">
          {stat.points} 个审批点 · {stat.files} 个文件
          {stat.revertable > 0 && ` · ${stat.revertable} 个可撤销`}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          className="ml-auto flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <Icon name="close" size={11} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] leading-[1.7] text-muted-foreground">
            这一会话还没有改过文件。
            <br />
            CC 用 Edit / Write 改动文件后，会按你说的每一次「允许」列在这里。
          </p>
        ) : (
          groups.map((g) => {
            const groupRevertable = g.points.some((p) =>
              p.files.some((f) => f.revert !== "none" && !reverted[revertKey(p.key, f.path)]),
            );
            return (
              <div key={g.turn}>
                <div className="flex items-center gap-2 border-y border-border/50 bg-muted/45 px-3 py-[4px] first:border-t-0">
                  <span className="text-[10.5px] font-semibold text-muted-foreground">
                    第 {g.turn} 轮
                  </span>
                  <span className="text-[10.5px] text-muted-foreground/80">
                    {g.points.length} 个审批点
                  </span>
                  <button
                    type="button"
                    onClick={() => onRevertGroup(g)}
                    disabled={!groupRevertable || busyKey !== null}
                    title={
                      groupRevertable
                        ? "把这一轮里所有可撤销的改动一起还原（逐条串行，失败即停）"
                        : "这一轮没有可撤销的改动"
                    }
                    className="ml-auto flex h-5 items-center rounded-md border border-border px-1.5 text-[10.5px] text-muted-foreground transition-colors hover:border-primary/45 hover:text-foreground disabled:opacity-40"
                  >
                    整组撤销
                  </button>
                </div>
                {g.points.map((p) => (
                  <Row
                    key={p.key}
                    point={p}
                    busyKey={busyKey}
                    reverted={reverted}
                    onRevert={onRevertOne}
                    onJump={onJump}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>

      <p className="shrink-0 border-t border-border px-3 py-1.5 text-[10.5px] leading-[1.5] text-muted-foreground">
        可撤销的走审计备份或反向补丁；内容已被改动则整体拒绝，一个字不动。
      </p>
    </div>
  );
}
