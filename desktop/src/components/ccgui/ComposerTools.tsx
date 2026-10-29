import { useRef, useState, type ReactNode } from "react";
import { setSendKey, useSendKey, type SendKey } from "../../lib/ccSendKey";
import { Icon } from "../ui/icon";
import { ChatPopover } from "./ChatPopover";

/** 高频输入操作与发送状态；阅读偏好留在对话顶栏。 */
export function ComposerTools({
  controls, polishing, onPolish, running, stopping, onInterrupt, canSend, sending,
  imagesBusy, queuePaused, queueCount, onSend, onAttach, onMention, onCommand,
}: {
  controls?: ReactNode;
  polishing: boolean;
  onPolish?: () => void;
  running?: boolean;
  stopping?: boolean;
  onInterrupt?: () => void;
  canSend: boolean;
  sending: boolean;
  imagesBusy: boolean;
  queuePaused?: boolean;
  queueCount: number;
  onSend: () => void;
  onAttach: () => void;
  onMention: () => void;
  onCommand: () => void;
}) {
  const [extrasOpen, setExtrasOpen] = useState(false);
  const extrasAnchor = useRef<HTMLButtonElement>(null);
  const queued = running || (queuePaused && queueCount > 0);
  const label = sending ? "发送中" : imagesBusy ? "处理图片" : queued ? "排队发送" : "发送";
  return (
    <div className="cc-composer-tools">
      <div className="cc-composer-input-tools">
        <button ref={extrasAnchor} type="button" className="cc-composer-add" aria-label="添加内容" aria-expanded={extrasOpen} onClick={() => setExtrasOpen(!extrasOpen)}><Icon name="plus" size={16} /><span>添加内容</span></button>
        {extrasOpen && <ChatPopover anchorRef={extrasAnchor} label="添加内容" onClose={() => setExtrasOpen(false)} width={240}>
          <button type="button" className="cc-chat-menu-item" onClick={() => { setExtrasOpen(false); onAttach(); }}><Icon name="image" size={16} />添加图片</button>
          <button type="button" className="cc-chat-menu-item" aria-label="引用文件" onClick={() => { setExtrasOpen(false); requestAnimationFrame(onMention); }}>@ 引用文件</button>
          <button type="button" className="cc-chat-menu-item" onClick={() => { setExtrasOpen(false); requestAnimationFrame(onCommand); }}><Icon name="terminal" size={16} />查看命令</button>
          {onPolish && <button type="button" className="cc-chat-menu-item" disabled={polishing || !canSend || sending} onClick={() => { setExtrasOpen(false); onPolish(); }}><Icon name={polishing ? "spinner" : "paintbrush"} size={16} />{polishing ? "正在润色草稿" : "润色草稿"}</button>}
        </ChatPopover>}
        {controls && <span className="cc-composer-config">{controls}</span>}
      </div>
      <div className="cc-composer-send-tools">
        {running && onInterrupt && <button type="button" className="cc-composer-stop" aria-label={stopping ? "正在停止本轮" : "停止本轮"} disabled={stopping} onClick={onInterrupt} title="停止本轮并暂停发送队列，排队内容保留"><Icon name="pause" size={14} /><span>{stopping ? "停止中" : "停止本轮"}</span></button>}
        <button type="button" data-cc-send className="cc-composer-send" disabled={!canSend || sending || imagesBusy} onClick={onSend} aria-label={label} title={queued ? "加入队列，暂停时需手动继续" : undefined}><span>{label}</span><Icon name={sending || imagesBusy ? "spinner" : "arrowUp"} size={16} className={sending || imagesBusy ? "animate-spin" : undefined} /></button>
      </div>
    </div>
  );
}

export function ComposerFooter({ sendHint, children }: { sendHint: string; children?: ReactNode }) {
  const sendKey = useSendKey();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="cc-composer-footer">
      <button type="button" ref={anchorRef} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="设置发送快捷键" className="rounded text-left hover:text-foreground">{sendKey === "enter" ? "Enter 发送 · Shift Enter 换行" : `${sendHint} 发送 · Enter 换行`}</button>
      {children}
      {open && <ChatPopover anchorRef={anchorRef} onClose={() => setOpen(false)} label="输入偏好" width={290}>
        <div className="cc-chat-section"><strong>发送快捷键</strong></div>
        {(["enter", "ctrlEnter"] as SendKey[]).map(value => <button type="button" className="cc-chat-menu-item" key={value} aria-pressed={value === sendKey} onClick={() => { setSendKey(value); setOpen(false); }}><Icon name="check" size={15} className={value === sendKey ? "text-primary" : "opacity-0"} /><span>{value === "enter" ? "Enter 发送" : `${sendHint} 发送`}<small className="block text-muted-foreground">{value === "enter" ? "Shift + Enter 换行" : "Enter 换行"}</small></span></button>)}
      </ChatPopover>}
    </div>
  );
}
