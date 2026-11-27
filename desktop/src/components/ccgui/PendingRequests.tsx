import { createContext, useContext, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { ChatPopover } from "./ChatPopover";

export type PendingRequest = { id: string; tool: string };
export type PendingSession = { key: string; title: string; requests: PendingRequest[] };
export const PendingRequestsContext = createContext<{
  sessions: PendingSession[];
  select: (key: string, id: string) => void;
}>({ sessions: [], select: () => {} });

export function PendingRequests() {
  const { sessions, select } = useContext(PendingRequestsContext);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const count = sessions.reduce((total, session) => total + session.requests.length, 0);
  if (!count) return null;
  return <div className="cc-composer-pending">
    <Icon name="shield" size={14} />
    <span>{count} 项待处理</span>
    <button type="button" ref={anchor} data-cc-pending-trigger aria-expanded={open}
      onClick={() => setOpen(!open)}>查看请求</button>
    {open && <ChatPopover anchorRef={anchor} label="待处理请求" onClose={() => setOpen(false)} width={340}>
      {sessions.map(session => <div key={session.key} className="cc-chat-section">
        <strong className="block truncate" title={session.title}>{session.title}</strong>
        {session.requests.map(request => <button type="button" className="cc-chat-menu-item" key={request.id}
          onClick={() => { setOpen(false); select(session.key, request.id); }}>
          <Icon name={request.tool === "AskUserQuestion" ? "message" : "shield"} size={15} />
          {request.tool === "AskUserQuestion" ? "回答问题" : `审阅 ${request.tool}`}
        </button>)}
      </div>)}
    </ChatPopover>}
  </div>;
}
