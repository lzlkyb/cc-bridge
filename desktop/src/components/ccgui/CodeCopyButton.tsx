import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { Icon } from "../ui/icon";

/**
 * 代码块右上角的复制按钮。
 *
 * 独立成组件是为了让「已复制」这 2 秒的状态**只重渲染它自己**：此前复制状态挂在
 * 整段 Markdown 的父组件上，`isCopied` 每次都是新函数 ⇒ 一按复制，整条回复的所有
 * 块全部重渲染一次（块级 memo 直接失效）。每个按钮一个 `useCopyFeedback` 实例，
 * 状态天然隔离，key 也就不需要再区分第几个代码块。
 */
export function CodeCopyButton({ text, className = "" }: { text: string; className?: string }) {
  const { copy, isCopied } = useCopyFeedback();
  const copied = isCopied("code");
  return (
    <button
      type="button"
      onClick={() => copy("code", text)}
      title={copied ? "已复制" : "复制代码"}
      aria-label="复制代码"
      aria-live="polite"
      className={`flex h-6 items-center gap-1 rounded border border-border bg-card/90 px-1.5 text-[11px] text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 ${className}`}
    >
      <Icon name={copied ? "check" : "copy"} size={10} />
      {copied ? "已复制" : "复制"}
    </button>
  );
}
