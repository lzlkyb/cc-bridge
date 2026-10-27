import { memo } from "react";
import type { CcPermissionMode, CcMessage, CcSession } from "../../lib/ccGuiTypes";
import type { CcHistoryRow } from "../../lib/ccEventTypes";
import { Icon } from "../ui/icon";
import { CwdChip } from "./CwdChip";
import { ReadingOptions } from "./ReadingOptions";
import { SessionActions } from "./SessionActions";

export type SessionBarProps = {
  session: CcSession;
  messages: CcMessage[];
  resolved: Record<string, { decision: "allow" | "deny"; auto?: boolean }>;
  title: string;
  targets: { id: string; label: string }[];
  targetId: string;
  onTargetChange: (id: string) => void;
  mode: CcPermissionMode;
  onModeChange: (mode: CcPermissionMode) => void;
  onModelChange: (model: string) => void;
  onCwdChange: (cwd: string) => void;
  isRemote: boolean;
  onSwitchTerminal: () => void;
  onNewSession: () => void;
  newSessionHint: string;
  onOpenHistory: (row: CcHistoryRow) => void;
  onJumpTo: (messageId: string) => void;
  onFind?: () => void;
  onToggleSidebar?: () => void;
  sidebarExpanded?: boolean;
  compact?: boolean;
  connectionStatus?: string;
};

function SessionBarImpl({ session, messages, resolved, title, targets, targetId, onTargetChange,
  onCwdChange, isRemote, onSwitchTerminal, onNewSession, newSessionHint, onOpenHistory,
  onJumpTo, onFind, onToggleSidebar, sidebarExpanded, connectionStatus }: SessionBarProps) {
  return <header data-cc-rule className="cc-conversation-head">
    {onToggleSidebar && <button type="button" className="cc-chat-icon cc-sidebar-toggle" data-cc-sidebar-toggle aria-label={sidebarExpanded ? "收起会话列表" : "展开会话列表"} aria-expanded={sidebarExpanded} onClick={onToggleSidebar}><Icon name="panelLeft" size={17} /></button>}
    <div className="cc-conversation-heading">
      <h1 title={title}>{title || "新对话"}</h1>
      <div className="cc-conversation-environment">
        <label className="cc-target-select"><Icon name={isRemote ? "server" : "folder"} size={13} />
          <select aria-label="对话运行在哪" value={targetId} onChange={(e) => onTargetChange(e.target.value)}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label><span aria-hidden>/</span>
        <CwdChip cwd={session.cwd} isRemote={isRemote} hasMessages={messages.some((m) => m.kind === "user")} onChange={onCwdChange} />
        {connectionStatus && <span className="cc-connection-label">{connectionStatus}</span>}
      </div>
    </div>
    <div className="cc-conversation-actions">
      <button type="button" className="cc-chat-icon" aria-label="搜索当前对话" title="搜索当前对话 · Ctrl+F" onClick={onFind}><Icon name="search" size={17} /></button>
      <ReadingOptions />
      <SessionActions session={session} messages={messages} resolved={resolved} title={title} modelLabel={session.model || session.activeModel || "默认模型"} newSessionHint={newSessionHint} onOpenHistory={onOpenHistory} onJumpTo={onJumpTo} onNewSession={onNewSession} onSwitchTerminal={onSwitchTerminal} />
    </div>
  </header>;
}
export const SessionBar = memo(SessionBarImpl);
