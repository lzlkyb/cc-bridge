import { useContext, useRef, useState } from "react";
import { ConversationEnvironment } from "./ApprovalEnvironment";
import { ChatPopover } from "./ChatPopover";
export function DraftContextList({ value, onChange, hasImages }: { value: string; onChange: (value: string) => void; hasImages: boolean }) {
  const [open, setOpen] = useState(false), anchor = useRef<HTMLButtonElement>(null);
  const env = useContext(ConversationEnvironment);
  const refs = Array.from(value.matchAll(/(?:^|\s)(@[^\s]+)/g));
  return <><button type="button" ref={anchor} className="cc-draft-context-trigger" onClick={() => setOpen(!open)} aria-expanded={open}>上下文清单{refs.length ? ` · ${refs.length} 项引用` : ""}</button>
    {open && <ChatPopover anchorRef={anchor} label="上下文清单" width={350} onClose={() => setOpen(false)}>
      <div className="cc-chat-section"><strong>即将发送的内容 · 部分可见</strong></div><p className="cc-chat-note">这里只列出草稿中的文本引用和附件提示，不代表模型的完整上下文，也不代表文件已被读取。</p>
      {refs.length === 0 && <p className="cc-chat-note">草稿中没有 @文本引用。</p>}
      {refs.map((match, i) => <div key={`${match.index}-${i}`} className="cc-context-reference"><span>{match[1]}</span><button type="button" onClick={() => { const start = match.index! + match[0].length - match[1].length; onChange(value.slice(0, start) + value.slice(start + match[1].length)); }}>移除</button></div>)}
      {hasImages && <p className="cc-chat-note">图片已添加，可在输入区的附件预览中逐张移除。</p>}
      <p className="cc-chat-note">工作环境：{env.remote ? "SSH · " : ""}{env.label || "当前会话"} / {env.cwd || "默认目录"}</p>
      <p className="cc-chat-note">系统提示、自动检索及压缩摘要未包含在此清单中。</p>
    </ChatPopover>}</>;
}
