import { useLayoutEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { Collapse } from "../ui/Collapse";

/**
 * 会话断开后的横幅：写清楚原因 + 重连 / 关标签。
 *
 * WHY 用横幅而不是遮罩式浮层：断开后保留终端的**全部意义**就是让历史输出仍可读、可选、可复制；
 * 拿一层遮罩盖住它等于白保留。
 *
 * 槽位化（2026-10-17）：`reason` 改收 `string | null`，组件**常驻挂载**、内部套
 * Collapse 行槽位（0fr→1fr）——断连横幅出现/消失从「硬切推挤终端区高度」变成
 * 200ms 平滑展开/收起。断连会话没有远端 TUI 可重排，fit 代价低，动画安全。
 * `held`：重连收起动画期间保留最后一条 reason（瞬间变 null 会在收缩中闪空白）。
 */
export function SshDisconnectedBar({
  reason,
  onReconnect,
  onCloseTab,
}: {
  /** null = 会话在线（横幅收起）；非 null = 已断开，值为原因全文。 */
  reason: string | null;
  onReconnect: () => void;
  onCloseTab: () => void;
}) {
  const [held, setHeld] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (reason !== null) setHeld(reason);
  }, [reason]);
  const shown = reason ?? held;
  return (
    <Collapse open={reason !== null}>
      {shown !== null && (
        // amber 警示而非 destructive 红：断开可一键重连，不是错误态（设计稿同款语义）
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs">
          <Icon name="alertTriangle" size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="shrink-0 font-medium">连接已断开</span>
          {/* 原因可能很长（ssh 的诊断输出），截断显示，title 里放全文 */}
          <span title={shown} className="min-w-0 flex-1 truncate text-muted-foreground">
            {shown}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onReconnect}
              className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Icon name="plug" size={12} /> 重新连接
            </button>
            <button
              type="button"
              onClick={onCloseTab}
              className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              关闭标签
            </button>
          </div>
        </div>
      )}
    </Collapse>
  );
}
