import { memo, useState } from "react";
import { Icon } from "../ui/icon";

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
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
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
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-[12px] leading-[1.6] text-muted-foreground">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}

export const ThinkingBlock = memo(ThinkingBlockImpl);
