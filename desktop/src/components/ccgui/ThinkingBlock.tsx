import { memo, useState } from "react";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { Icon } from "../ui/icon";

/** 首个非空行。不用 `split("\n")`：流式期间每次渲染都全文拆一遍是 O(n²)， indexOf + slice 只扫到第一个换行。 */
function firstNonEmptyLine(text: string): string {
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end).trim();
    if (line) return line;
    if (nl === -1) return "";
    start = nl + 1;
  }
  return "";
}

/**
 * 思维链块：**默认折叠**的一行，点开看全文。
 *
 * 为什么折叠而不是不渲染：长任务里思考流是「它还活着」的唯一证据，
 * 几分钟没有正文输出时，用户看到的如果是空白，第一反应是卡死了。
 * 但也不能默认摊开 —— CC 的思考动辄几千字，会把正文冲出视口。
 *
 * 流式中（`running`）前缀显示呼吸点：这是「正在想」和「想完了」的区分，
 * 只看文字长度是分不出来的（想完了也可以很长）。
 */
function ThinkingBlockImpl({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState(false);
  const { copy, isCopied } = useCopyFeedback();
  const firstLine = firstNonEmptyLine(text);
  const summary = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine || "（空）";

  return (
    <div className="flex gap-2">
      <span className="mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-muted text-muted-foreground">
        <Icon name={open ? "chevronDown" : "arrowRight"} size={11} />
      </span>
      <div className="min-w-0 flex-1 pt-[1px]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex max-w-full items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {running && (
            <span className="h-[5px] w-[5px] shrink-0 animate-pulse rounded-full bg-primary" />
          )}
          <span className="shrink-0">{running ? "正在思考" : "思考过程"}</span>
          <span className="truncate opacity-70">· {summary}</span>
        </button>
        {open && (
          <div className="group/think relative mt-1">
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 pr-14 text-[12px] leading-[1.6] text-muted-foreground">
              {text}
            </pre>
            <button
              type="button"
              onClick={() => copy("text", text)}
              title={isCopied("text") ? "已复制" : "复制思考全文"}
              aria-label="复制思考全文"
              aria-live="polite"
              className="absolute right-1.5 top-1.5 flex h-5 items-center gap-1 rounded border border-border bg-card/90 px-1.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/think:opacity-100"
            >
              <Icon name={isCopied("text") ? "check" : "copy"} size={10} />
              {isCopied("text") ? "已复制" : "复制"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export const ThinkingBlock = memo(ThinkingBlockImpl);
