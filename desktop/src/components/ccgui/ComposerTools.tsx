import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { CHAT_TYPOGRAPHY, setChatTypography, useChatTypography, type ChatTypography } from "../../lib/chatTypography";
import { CHAT_VERBOSITY, setChatVerbosity, useChatVerbosity, type ChatVerbosity } from "../../lib/chatVerbosity";
import { SEND_KEY_META, toggleSendKey, useSendKey } from "../../lib/ccSendKey";

/**
 * 三档分段控件。
 *
 * 🔴 从「点一下切一档的循环钮」改过来：循环钮有三个说不出口的问题 ——
 *    看不出有几档、不知道该点几下、`aria-pressed` 也没有意义（它不是开关）。
 *    分段控件把三档一次摊开，当前档高亮，点哪儿去哪儿。与权限模式同一形态。
 */
function Seg<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: { value: T; label: string; hint: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <span
      role="group"
      aria-label={label}
      data-cc-seg
      className="flex items-center gap-px rounded-[7px] border border-border bg-muted/50 p-[2px]"
    >
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            aria-pressed={on}
            title={it.hint}
            onClick={() => onChange(it.value)}
            className={`rounded-[5px] px-1.5 py-[1px] text-[11px] leading-[16px] transition-colors ${
              on ? "bg-card font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </span>
  );
}

const TYPO_ITEMS: { value: ChatTypography; label: string; hint: string }[] = (
  ["s", "m", "l"] as ChatTypography[]
).map((v) => ({
  value: v,
  label: CHAT_TYPOGRAPHY[v].label,
  hint: `正文排版「${CHAT_TYPOGRAPHY[v].label}」（只作用对话正文，全局记忆）`,
}));

const VERB_ITEMS: { value: ChatVerbosity; label: string; hint: string }[] = (
  ["v", "n", "c"] as ChatVerbosity[]
).map((v) => ({
  value: v,
  label: CHAT_VERBOSITY[v].label.slice(0, 1),
  hint: `消息详略「${CHAT_VERBOSITY[v].label}」· ${CHAT_VERBOSITY[v].hint}（全局记忆）`,
}));

/**
 * 输入区底行（从 Composer 拆出，2026-10-26：给 @引用接线腾行数）。
 * 纯展示 + 回调：发送键提示（可点切换）、正文排版、消息详略、润色、中断、发送。
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
  /** `Ctrl+Enter` 的平台写法（Windows 上 `Ctrl+Enter`、mac 上 `⌘Enter`）。 */
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
  const sendKey = useSendKey();
  return (
    // flex-wrap：这一行最多有 7 项，窗口缩到最小宽度时要换行而不是挤压 / 溢出。
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-1.5">
      {/* 发送键提示本身就是切换入口：用户看着这四个字想改时，手就在这儿。
          比塞进设置页少走三步（设置 → 对话 → 找那一项），也不用新开一个浮层。 */}
      <button
        type="button"
        onClick={() => toggleSendKey()}
        title={`发送键：${SEND_KEY_META[sendKey].hint} · 点击切换`}
        aria-label="切换发送键"
        className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span
          data-cc-inset
          className="rounded border border-border bg-muted/60 px-[3px] py-[1px] font-mono text-[11px]"
        >
          {sendKey === "enter" ? "Enter" : sendHint}
        </span>
        发送
      </button>
      <span className="flex items-center gap-1">
        <span className="text-[11px] leading-[16px] text-muted-foreground">Aa</span>
        <Seg items={TYPO_ITEMS} value={typo} onChange={setChatTypography} label="正文排版" />
      </span>
      {/* 与「Aa」并排：两个都是「我这条会话想看多细」的全局偏好，放一起才找得到。
          档位只影响消息流的元信息层（思考 / 工具），不动正文与输入框。 */}
      <span className="flex items-center gap-1">
        <Icon name="sliders" size={11} className="shrink-0 opacity-70" />
        <Seg items={VERB_ITEMS} value={verbosity} onChange={setChatVerbosity} label="消息详略" />
      </span>
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
          // 说清它对队列做了什么：此前只写在 tooltip 里，用户中断完发现排队的三句
          // 也没了。现在中断**不动队列**（见 useCcSession.interrupt），文案跟着改。
          title="中断本轮（已排队的消息会保留，本轮结束后继续发）"
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
