import { memo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CcHistoryRow } from "../../lib/ccEventTypes";
import type { CcMessage, CcSession } from "../../lib/ccGuiTypes";
import { useCcApprovalAudit } from "../../hooks/useCcApprovalAudit";
import { useCcExport } from "../../hooks/useCcExport";
import { Icon } from "../ui/icon";
import { ApprovalAuditPanel } from "./ApprovalAuditPanel";
import { HistoryPanel } from "./HistoryPanel";
import { ChatPopover } from "./ChatPopover";

function SessionActionsImpl({ session, messages, resolved, title, modelLabel, newSessionHint,
  onOpenHistory, onJumpTo, onNewSession, onSwitchTerminal }: {
  session: CcSession; messages: CcMessage[];
  resolved: Record<string, { decision: "allow" | "deny"; auto?: boolean }>;
  title: string; modelLabel: string; newSessionHint: string;
  onOpenHistory: (row: CcHistoryRow) => void;
  onJumpTo: (messageId: string) => void;
  onNewSession: () => void; onSwitchTerminal: () => void;
}) {
  const [open, setOpen] = useState<"more" | "info" | "history" | "changes" | null>(null);
  const [changesFromMenu, setChangesFromMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const changesAnchor = useRef<HTMLButtonElement>(null);
  const audit = useCcApprovalAudit({ messages, resolved, cwd: session.cwd, sessionId: session.sessionId, enabled: open === "changes" });
  const { exportMarkdown, canExport } = useCcExport({ messages, title, cwd: session.cwd, model: modelLabel });
  return <>
    {session.changeset.length > 0 && <button ref={changesAnchor} type="button" className="cc-chat-chip cc-changes-trigger" data-cc-toggle="changeset" aria-label="本会话改动" aria-expanded={open === "changes"} title={`本会话改动：${session.changeset.length} 个文件`} onClick={() => { setChangesFromMenu(false); setOpen(open === "changes" ? null : "changes"); }}><Icon name="file" size={15} /><span>{session.changeset.length}</span></button>}
    <button ref={anchor} type="button" className="cc-chat-icon" aria-label="更多会话操作" aria-expanded={open !== null && open !== "changes"} data-cc-toggle="history" onClick={() => setOpen(open ? null : "more")}><Icon name="more" size={18} /></button>
    {(open === "more" || open === "info") && <ChatPopover anchorRef={anchor} label={open === "info" ? "会话信息" : "会话操作"} onClose={() => setOpen(null)}>
      <div className="cc-chat-section"><strong>{open === "info" ? "会话信息" : "会话操作"}</strong></div>
      {open === "info" ? <>
        <dl className="cc-session-info"><dt>当前模型</dt><dd>{modelLabel}</dd><dt>工作目录</dt><dd>{session.cwd || "默认目录"}</dd><dt>分支</dt><dd>{session.branch || "未检测到"}</dd><dt>累计用量</dt><dd>{(session.inputTokens + session.outputTokens).toLocaleString()} tokens</dd><dt>累计费用</dt><dd>${session.costUsd.toFixed(2)}</dd></dl>
        <button className="cc-chat-menu-item" type="button" onClick={() => setOpen("more")}><Icon name="arrowLeft" size={15} />返回会话操作</button>
      </> : <>
        <button className="cc-chat-menu-item" type="button" onClick={() => setOpen("info")}><Icon name="activity" size={16} /><span>会话信息<small>模型、用量与费用</small></span></button>
        {session.changeset.length > 0 && <button className="cc-chat-menu-item" type="button" onClick={() => { setChangesFromMenu(true); setOpen("changes"); }}><Icon name="file" size={16} /><span>本会话改动<small>{session.changeset.length} 个文件</small></span></button>}
        <button className="cc-chat-menu-item" type="button" disabled={!canExport} onClick={() => { exportMarkdown(); setOpen(null); }}><Icon name="download" size={16} /><span>导出对话<small>复制为 Markdown</small></span></button>
        <button className="cc-chat-menu-item" type="button" onClick={() => setOpen("history")}><Icon name="history" size={16} /><span>从本机历史打开<small>包含终端中的 Claude Code 对话</small></span></button>
        <button className="cc-chat-menu-item" type="button" onClick={() => { setOpen(null); onNewSession(); }}><Icon name="plus" size={16} /><span>新对话<small>{newSessionHint} · 当前会话保留</small></span></button>
        <button className="cc-chat-menu-item" type="button" onClick={() => { setOpen(null); onSwitchTerminal(); }}><Icon name="terminal" size={16} />切换到终端</button>
      </>}
    </ChatPopover>}
    {open === "history" && createPortal(<HistoryPanel onClose={() => setOpen(null)} onOpen={(row) => { setOpen(null); onOpenHistory(row); }} anchorRef={anchor} />, document.body)}
    {open === "changes" && createPortal(<ApprovalAuditPanel groups={audit.groups} stat={audit.stat} reverted={audit.reverted} busyKey={audit.busyKey} onRevertOne={(p, f) => void audit.revertOne(p, f)} onRevertGroup={(g) => void audit.revertGroup(g)} onJump={(id) => { setOpen(null); onJumpTo(id); }} onClose={() => setOpen(null)} anchorRef={changesFromMenu ? anchor : changesAnchor} />, document.body)}
  </>;
}
export const SessionActions = memo(SessionActionsImpl);
