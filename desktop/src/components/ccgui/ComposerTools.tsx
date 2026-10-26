import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { CHAT_TYPOGRAPHY, cycleChatTypography, useChatTypography } from "../../lib/chatTypography";
import { CHAT_VERBOSITY, cycleChatVerbosity, useChatVerbosity } from "../../lib/chatVerbosity";

/**
 * 输入区底行（从 Composer 拆出，2026-10-26：给 @引用接线腾行数）。
 * 纯展示 + 回调，含「Aa」排版循环钮（小→中→大，全局记忆，只作用正文）
 * 与「详略」循环钮（详细→标准→精简，全局记忆，只作用消息流）。
 */
export function ComposerTools({
  sendHint,
  polishBackup,
  onUndoPolish,
  polishing,
  onPolish,
  running,
  onInterrupt,
  canSend,
  onSend,
}: {
  sendHint: string;
  polishBackup: string | null;
  onUndoPolish: () => void;
  polishing: boolean;
  onPolish?: () => void;
  running?: boolean;
  onInterrupt?: () => void;
  canSend: boolean;
  onSend: () => void;
}) {
  const typo = useChatTypography();
  const verbosity = useChatVerbosity();
  return (
    // flex-wrap：这一行最多有 7 项，窗口缩到最小宽度时要换行而不是挤压 / 溢出。
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-1.5">
      <span className="text-[11px] text-muted-foreground">
        <span data-cc-inset className="rounded border border-border bg-muted/60 px-[3px] py-[1px] font-mono text-[11px]">
          {sendHint}
        </span>{" "}
        发送
      </span>
      <button
        type="button"
        onClick={cycleChatTypography}
        title={`正文排版：当前「${CHAT_TYPOGRAPHY[typo].label}」· 点击切换（全局记忆，只作用正文）`}
        aria-label="切换正文排版大小"
        className="flex h-[26px] items-center gap-1 rounded-[7px] border border-border px-[7px] text-[11.5px] text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-primary/45 aria-pressed:text-primary"
        aria-pressed={typo !== "m"}
      >
        Aa · {CHAT_TYPOGRAPHY[typo].label}
      </button>
      {/* 与「Aa」并排：两个都是「我这条会话想看多细」的全局偏好，放一起才找得到。
          档位只影响消息流的元信息层（思考 / 工具），不动正文与输入框。 */}
      <button
        type="button"
        onClick={cycleChatVerbosity}
        title={`消息详略：当前「${CHAT_VERBOSITY[verbosity].label}」· ${CHAT_VERBOSITY[verbosity].hint}（点击切换，全局记忆）`}
        aria-label="切换消息详略"
        className="flex h-[26px] items-center gap-1 rounded-[7px] border border-border px-[7px] text-[11.5px] text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-primary/45 aria-pressed:text-primary"
        aria-pressed={verbosity !== "n"}
      >
        <Icon name="sliders" size={11} className="shrink-0 opacity-70" />
        {CHAT_VERBOSITY[verbosity].label}
      </button>
      {polishBackup !== null && (
        <button
          type="button"
          onClick={onUndoPolish}
          className="text-[11px] text-muted-foreground underline decoration-dotted transition-colors hover:text-foreground"
        >
          撤销润色
        </button>
      )}
      {onPolish && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[12px] text-muted-foreground"
          disabled={polishing || !canSend}
          onClick={onPolish}
          title="用提示词改写器把草稿改写成更清晰、可执行的指令（mods/prompt-polish）"
        >
          <Icon name={polishing ? "spinner" : "paintbrush"} size={12} />
          {polishing ? "润色中" : "润色"}
        </Button>
      )}
      {running && onInterrupt && (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-7 px-3 text-[12px]"
          onClick={onInterrupt}
          title="中断本轮（同时清空已排队的消息）"
        >
          中断
        </Button>
      )}
      <Button
        size="sm"
        className={`${running && onInterrupt ? "" : "ml-auto"} h-7 px-3 text-[12px]`}
        disabled={!canSend}
        onClick={onSend}
        title={running ? "本轮还在生成：这条会排队，本轮结束后自动发送" : undefined}
      >
        {running ? "排队" : "发送"}
      </Button>
    </div>
  );
}
