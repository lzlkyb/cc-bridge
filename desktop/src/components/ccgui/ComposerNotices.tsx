import { useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { SLASH_WHITELIST_TEXT } from "../../lib/ccSlash";
import type { QueuedMessage } from "../../hooks/useCcSendQueue";
import { ChatPopover } from "./ChatPopover";

export function ComposerNotices({
  queueCount, queuePaused = false, queueItems = [], onClearQueue, onResumeQueue,
  onEditQueue, onRemoveQueue, slashReject, pendingCount = 0, onShowPending,
}: {
  queueCount: number;
  queuePaused?: boolean;
  queueItems?: QueuedMessage[];
  onClearQueue: () => void;
  onResumeQueue?: () => void;
  onEditQueue?: (id: string, text: string) => boolean;
  onRemoveQueue?: (id: string) => void;
  slashReject: string | null;
  pendingCount?: number;
  onShowPending?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string; images: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      {pendingCount > 0 && <div className="cc-composer-pending"><Icon name="shield" size={14} /><span>{pendingCount} 项操作等待确认</span>{onShowPending && <button type="button" onClick={onShowPending}>查看审批</button>}</div>}
      {queueCount > 0 && (
        <div className="cc-composer-queue">
          <div className="cc-composer-queue-head"><Icon name={queuePaused ? "pause" : "clock"} size={14} /><strong>{queuePaused ? "队列已暂停" : "已排队"} · {queueCount} 条</strong><span>{queuePaused ? "内容已保留" : "本轮结束后发送"}</span>
            {queuePaused && onResumeQueue && <button type="button" onClick={onResumeQueue}>继续发送</button>}
            <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "收起" : "管理"}</button>
          </div>
          {!expanded && queueItems[0] && <p className="cc-composer-queue-peek">下一条：{queueItems[0].text || "图片消息"}{queueItems[0].images.length > 0 && ` · ${queueItems[0].images.length} 张图片`}</p>}
          {expanded && <div className="cc-composer-queue-items">
            {queueItems.map((item, index) => <div key={item.id} className="cc-composer-queue-item"><span>{index + 1}</span><p title={item.text}>{item.text || "图片消息"}{item.images.length > 0 && <small> · {item.images.length} 张图片</small>}</p>
              {onEditQueue && <button type="button" className="cc-chat-icon" aria-label={`编辑第 ${index + 1} 条排队消息`} onClick={event => { anchorRef.current = event.currentTarget; setEditing({ id: item.id, text: item.text, images: item.images.length }); }}><Icon name="edit" size={14} /></button>}
              {onRemoveQueue && <button type="button" className="cc-chat-icon" aria-label={`移除第 ${index + 1} 条排队消息`} onClick={() => onRemoveQueue(item.id)}><Icon name="close" size={14} /></button>}
            </div>)}
            <button type="button" className="cc-composer-clear" onClick={onClearQueue}>清空队列</button>
          </div>}
        </div>
      )}
      {editing && <ChatPopover anchorRef={anchorRef} onClose={() => setEditing(null)} label="编辑排队消息" width={360}>
        <form className="cc-chat-section" onSubmit={event => { event.preventDefault(); const accepted = onEditQueue?.(editing.id, editing.text); setEditing(null); if (!accepted) toast("这条消息已开始发送，未修改后续消息", "info"); }}>
          <label htmlFor={`queue-edit-${editing.id}`} className="block font-medium">编辑排队消息</label>
          <textarea id={`queue-edit-${editing.id}`} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} className="cc-composer-edit" rows={4} />
          {editing.images > 0 && <p className="cc-chat-note">保留 {editing.images} 张图片</p>}
          <div className="cc-composer-edit-actions"><button type="button" onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={!editing.text.trim() && editing.images === 0}>保存</button></div>
        </form>
      </ChatPopover>}
      {slashReject && <div className="cc-composer-reject" role="status"><Icon name="alertTriangle" size={14} /><span>未发送 {slashReject}：支持 {SLASH_WHITELIST_TEXT}，其他命令请到终端运行。引用绝对路径时，请在前面加上说明文字。</span></div>}
    </>
  );
}
