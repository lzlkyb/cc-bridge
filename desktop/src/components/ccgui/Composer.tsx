import { memo, useState } from "react";
import { Button } from "../ui/button";

/**
 * 输入区（接管 composer 位置，不弹模态）。
 *
 * 采用 dock 而非对话框的理由：审批/追问时用户往往要边看上面的 diff 边决定，
 * 模态会把这些上下文盖住。desktop-cc-gui 的 `QuestionCard` 也是这个做法。
 *
 * `rows={1}` 是刻意的：接真协议后改成随内容自动增高，起始单行 ——
 * 输入区越矮，上面留给对话流的越高（审批卡被顶出视口是最糟的失败）。
 *
 * `running` 时发送按钮禁用：一轮一进程，同一时刻只能有一条消息在飞。
 * 此时给出「中断」—— 没有它，卡住的一轮只能靠关窗解决。
 */
function ComposerImpl({
  onSend,
  running,
  onInterrupt,
  placeholder,
}: {
  onSend: (text: string) => void;
  running?: boolean;
  onInterrupt?: () => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");

  const send = () => {
    const text = value.trim();
    if (!text || running) return;
    onSend(text);
    setValue("");
  };

  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
      {/* data-cc-composer：玻璃下 composer 要压过 .ui-card 的 reading 档，改 floating
          （唯一「必须实心」的输入位）；classic 下不加任何样式。 */}
      <div
        data-cc-composer
        className="ui-card rounded-xl border border-border bg-card shadow-card transition-colors focus-within:border-primary/50"
      >
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Windows 风格窗口：Ctrl+Enter 发送（不是 ⌘）。
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={placeholder ?? "给 CC 发消息…"}
          className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[13px] leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-2 px-2 pb-1.5">
          <span className="text-[11px] text-muted-foreground">
            <span data-cc-inset className="rounded border border-border bg-muted/60 px-[3px] py-[1px] font-mono text-[11px]">
              Ctrl
            </span>
            {" + "}
            <span data-cc-inset className="rounded border border-border bg-muted/60 px-[3px] py-[1px] font-mono text-[11px]">
              Enter
            </span>{" "}
            发送
          </span>
          {running && onInterrupt && (
            <Button variant="outline" size="sm" className="ml-auto h-7 px-3 text-[12px]" onClick={onInterrupt}>
              中断
            </Button>
          )}
          <Button
            size="sm"
            className={`${running && onInterrupt ? "" : "ml-auto"} h-7 px-3 text-[12px]`}
            disabled={!value.trim() || running}
            onClick={send}
          >
            发送
          </Button>
        </div>
      </div>
    </div>
  );
}

export const Composer = memo(ComposerImpl);
