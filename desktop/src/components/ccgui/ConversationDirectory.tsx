import { useRef, useState } from "react";
import type { CcMessage } from "../../lib/ccGuiTypes";
import { Icon } from "../ui/icon";
import { ChatPopover } from "./ChatPopover";
export function ConversationDirectory({ messages }: { messages: CcMessage[] }) {
  const [open, setOpen] = useState(false), [returnTop, setReturnTop] = useState<number | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const questions = messages.filter(m => m.kind === "user");
  const stream = () => anchor.current?.closest("[data-cc-panel]")?.querySelector<HTMLElement>("[data-cc-stream]");
  return <><button ref={anchor} type="button" className="cc-chat-icon" aria-label="问题目录" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="list" size={17}/></button>
    {returnTop !== null && <button className="cc-reading-return" type="button" onClick={() => { stream()?.scrollTo({ top: returnTop }); setReturnTop(null); }}>回到刚才阅读处</button>}
    {open && <ChatPopover anchorRef={anchor} label="问题目录" width={340} onClose={() => setOpen(false)}><div className="cc-chat-section"><strong>问题目录 · {questions.length} 轮</strong></div>
      {questions.length === 0 && <p className="cc-chat-note">发送第一个问题后，这里会列出你的提问。</p>}
      {questions.map((m, index) => <button key={m.id} type="button" className="cc-chat-menu-item" onClick={() => {
        const root = stream(), node = root?.querySelector<HTMLElement>(`[data-cc-msg="${CSS.escape(m.id)}"]`); if (!node || !root) return;
        setReturnTop(root.scrollTop); setOpen(false); requestAnimationFrame(() => { node.scrollIntoView({ block: "center" }); node.classList.add("anchor-highlight"); window.setTimeout(() => node.classList.remove("anchor-highlight"), 2000); });
      }}><span>{index + 1}. {m.kind === "user" ? m.text || "图片消息" : ""}</span></button>)}
    </ChatPopover>}</>;
}
