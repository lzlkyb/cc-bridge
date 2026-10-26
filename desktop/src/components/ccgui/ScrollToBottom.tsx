import { Icon } from "../ui/icon";

/**
 * 「回到底部」浮钮：用户上滚回看、离开了底部时出现在消息流底部居中。
 *
 * 有待批准的审批 / 提问时换成醒目的警示色并写明条数：审批卡有 60s 超时，
 * 弹在视口外用户看不到，这是这个按钮最重要的用途。
 */
export function ScrollToBottom({
  pending,
  running,
  onClick,
}: {
  /** 等待用户裁决的审批 / 提问条数。 */
  pending: number;
  running: boolean;
  onClick: () => void;
}) {
  const warn = pending > 0;
  const label = warn ? `有 ${pending} 条待批准 · 回到底部` : running ? "回到底部 · 生成中" : "回到底部";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`absolute bottom-3 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 text-[12px] shadow-card transition-colors ${
        warn
          ? "border-warning/60 bg-warning/15 font-semibold text-warning-ink hover:bg-warning/25"
          : "border-border bg-card text-foreground hover:bg-muted"
      }`}
    >
      <Icon name="chevronDown" size={13} className="shrink-0" />
      {label}
    </button>
  );
}
