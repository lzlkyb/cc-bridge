import { memo, useEffect, useRef, useState } from "react";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { useChatVerbosity } from "../../lib/chatVerbosity";
import { Icon } from "../ui/icon";
import { thinkingTitle } from "./summarize";
import { MarkedText } from "./MarkedText";
import type { CcMark } from "../../lib/ccMarkdown";

/**
 * 思维链块：**默认折叠**的一行，点开看全文。
 *
 * 为什么折叠而不是不渲染：长任务里思考流是「它还活着」的唯一证据，
 * 几分钟没有正文输出时，用户看到的如果是空白，第一反应是卡死了。
 * 但也不能默认摊开 —— CC 的思考动辄几千字，会把正文冲出视口。
 *
 * 流式中（`running`）前缀显示呼吸点：这是「正在想」和「想完了」的区分，
 * 只看文字长度是分不出来的（想完了也可以很长）。
 *
 * `titleMarks`：会话内搜索的标题命中（标题只有一段，marks 恒为 seg 0）。
 */
function ThinkingBlockImpl({ text, running, titleMarks }: { text: string; running: boolean; titleMarks?: CcMark[] }) {
  const verbosity = useChatVerbosity();
  // 「详细」档默认摊开；另两档维持折叠一行。用户手点过的展开态优先，直到切档为止。
  const [open, setOpen] = useState(verbosity === "v");
  const { copy, isCopied } = useCopyFeedback();
  const summary = thinkingTitle(text);

  // 切档时把展开态拉回该档默认：在「详细」下摊开的几千字，切到「精简」还继续
  // 占着视口就失去了这个开关的意义。只在**档位真的变了**时动手 —— 拿 `text`
  // 做依赖会把流式期间用户手点开的块每秒重置一次。
  const prevVerbosity = useRef(verbosity);
  useEffect(() => {
    if (prevVerbosity.current === verbosity) return;
    prevVerbosity.current = verbosity;
    setOpen(verbosity === "v");
  }, [verbosity]);

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
          <span className="truncate opacity-70">· <MarkedText text={summary} marks={titleMarks} /></span>
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
