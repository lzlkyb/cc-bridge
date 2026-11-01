import type { CcMark } from "../../lib/ccMarkdown";
import { Icon } from "../ui/icon";
import { MarkedText } from "./MarkedText";
import { TOOL_TEXT_LIMIT } from "./summarize";

/**
 * 等宽输出块：Bash 的 stdout 与「其他工具」的 JSON 兜底共用。
 *
 * 从 `ToolCard` 拆出（2026-11）：它是一段自成一体的呈现（左线 + 极淡底色 +
 * 悬浮复制 + 截断提示），与工具行的展开逻辑无关；留在原文件里把那个组件顶过了
 * 体量门限，也让「一行怎么画」和「一段输出怎么画」混在一处读。
 *
 * 🔴 刻意不用「外框 + 圆角 + 底色」：工具行本身已经没有卡片外壳，再套一个 rounded
 *    border 就是卡中卡。改成左侧 2px 细线 + 极淡底色，照样和普通文字分层，
 *    但不多出一层容器（hermes-webui：If a card contains another card, one of
 *    them is probably unnecessary / Use almost no shadows in the transcript）。
 *
 * `clipped` 时正文是截断版，但**复制仍复制全文** —— 复制本来就是给「想拿完整
 * 输出去别处」的人用的，复制到一半等于没复制。
 */
export function MonoBlock({
  text,
  tone = "plain",
  clipped = false,
  copied = false,
  marks,
  onCopy,
}: {
  text: string;
  tone?: "plain" | "error";
  clipped?: boolean;
  copied?: boolean;
  /** 会话内搜索在**这段正文**里的命中（`summarize.convSegments` 的 seg 1）。 */
  marks?: CcMark[];
  onCopy?: () => void;
}) {
  return (
    <div className="group/mono relative">
      <pre
        data-cc-inset
        className={`max-h-[168px] overflow-auto whitespace-pre-wrap break-words border-l-2 bg-muted/25 px-2.5 py-1.5 pr-14 font-mono text-[12px] leading-[1.6] ${
          tone === "error"
            ? "border-destructive/50 text-destructive-ink"
            : "border-border text-muted-foreground"
        }`}
      >
        <MarkedText text={text} marks={marks} />
      </pre>
      {clipped && (
        <p className="px-2.5 pt-1 text-[11px] text-muted-foreground">
          内容过长，仅显示前 {TOOL_TEXT_LIMIT / 1000}k 字符（完整内容在会话记录里）
        </p>
      )}
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          title={copied ? "已复制" : "复制全文"}
          aria-label="复制全文"
          aria-live="polite"
          className="absolute right-1.5 top-1.5 flex h-6 items-center gap-1 rounded border border-border bg-card/90 px-1.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/mono:opacity-100"
        >
          <Icon name={copied ? "check" : "copy"} size={10} />
          {copied ? "已复制" : "复制"}
        </button>
      )}
    </div>
  );
}
