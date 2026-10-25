import { Icon } from "../ui/icon";

/**
 * 对话流里的一行提示（重试中 / 错误 / 缓冲溢出）。
 *
 * 为什么不用 toast：这些是**内容**，不是打扰。用户要能回头看到
 * 「刚才那句为什么失败了」，而 toast 三秒后就没了。
 *
 * 单独成文件是因为 `CcGuiTab` 贴着体量门禁（300 行）—— 它只是个纯展示组件，
 * 放在页面里只会让那个文件继续变胖，而它和页面逻辑没有任何耦合。
 */
export function Notice({
  tone,
  children,
  onDismiss,
}: {
  tone: "info" | "warn" | "error";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const color =
    tone === "error"
      ? "border-destructive/35 bg-destructive/[.06] text-destructive-ink"
      : tone === "warn"
        ? "border-warning/35 bg-warning/[.06] text-warning-ink"
        : "border-border bg-muted/40 text-muted-foreground";
  return (
    <div
      className={`flex shrink-0 items-start gap-1.5 border-b px-3 py-1.5 text-[11px] leading-[1.5] ${color}`}
    >
      <Icon name={tone === "info" ? "info" : "alertTriangle"} size={11} className="mt-[3px] shrink-0" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 opacity-70 hover:opacity-100"
          title="关闭"
        >
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
  );
}
