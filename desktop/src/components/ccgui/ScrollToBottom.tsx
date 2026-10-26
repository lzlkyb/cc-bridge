import { Icon } from "../ui/icon";

/**
 * 「回到底部」浮钮：用户上滚回看、离开了底部时出现在消息流底部。
 *
 * 定位不在这里 —— 它和「按轮导航」并排放在同一条浮条里（见
 * `ConversationStream`）。自己带 absolute 的话，两者会各自以容器居中而叠在一起。
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
      className={`pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12px] shadow-card transition-colors ${
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
