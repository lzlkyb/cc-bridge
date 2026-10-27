import { useRef, useState } from "react";
import { CHAT_TYPOGRAPHY, setChatTypography, useChatTypography, type ChatTypography } from "../../lib/chatTypography";
import { CHAT_VERBOSITY, setChatVerbosity, useChatVerbosity, type ChatVerbosity } from "../../lib/chatVerbosity";
import { Icon } from "../ui/icon";
import { ChatPopover } from "./ChatPopover";

export function ReadingOptions() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const typography = useChatTypography();
  const verbosity = useChatVerbosity();
  return <>
    <button ref={anchor} type="button" className="cc-chat-icon" aria-label="阅读选项" aria-expanded={open} onClick={() => setOpen(!open)} title="阅读选项">
      <Icon name="sliders" size={17} />
    </button>
    {open && <ChatPopover anchorRef={anchor} onClose={() => setOpen(false)} label="阅读选项">
      <div className="cc-chat-section"><strong>阅读选项</strong></div>
      <div className="cc-chat-section"><p className="cc-chat-note">正文字号</p><div className="cc-reading-options" role="group" aria-label="正文排版">
        {(["s", "m", "l"] as ChatTypography[]).map((key) => <button type="button" key={key} aria-pressed={typography === key} onClick={() => setChatTypography(key)}>{CHAT_TYPOGRAPHY[key].label}</button>)}
      </div></div>
      <div className="cc-chat-section"><p className="cc-chat-note">执行过程</p><div className="cc-reading-options" role="group" aria-label="消息详略">
        {(["c", "n", "v"] as ChatVerbosity[]).map((key) => <button type="button" key={key} aria-pressed={verbosity === key} title={CHAT_VERBOSITY[key].hint} onClick={() => setChatVerbosity(key)}>{CHAT_VERBOSITY[key].label}</button>)}
      </div></div>
      <p className="cc-chat-section cc-chat-note">只改变阅读方式。失败、审批与提问始终显示。</p>
    </ChatPopover>}
  </>;
}
