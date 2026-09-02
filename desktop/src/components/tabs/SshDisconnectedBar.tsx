import { Icon } from "../ui/icon";

/**
 * 会话断开后的横幅：写清楚原因 + 重连 / 关标签。
 *
 * WHY 用横幅而不是遮罩式浮层：断开后保留终端的**全部意义**就是让历史输出仍可读、可选、可复制；
 * 拿一层遮罩盖住它等于白保留。
 */
export function SshDisconnectedBar({
  reason,
  onReconnect,
  onCloseTab,
}: {
  reason: string;
  onReconnect: () => void;
  onCloseTab: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs">
      <Icon name="alertTriangle" size={13} className="shrink-0 text-destructive" />
      <span className="shrink-0 font-medium">连接已断开</span>
      {/* 原因可能很长（ssh 的诊断输出），截断显示，title 里放全文 */}
      <span title={reason} className="min-w-0 flex-1 truncate text-muted-foreground">
        {reason}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onReconnect}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Icon name="plug" size={12} /> 重新连接
        </button>
        <button
          type="button"
          onClick={onCloseTab}
          className="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          关闭标签
        </button>
      </div>
    </div>
  );
}
