import { useRef, useState, type ReactNode } from "react";
import { setSendKey, useSendKey, type SendKey } from "../../lib/ccSendKey";
import { Icon } from "../ui/icon";
import { ChatPopover } from "./ChatPopover";
import type { CcInputMode } from "../../lib/ccInput";

/** 高频输入操作与发送状态；阅读偏好留在对话顶栏。 */
export function ComposerTools({
  controls, delivery = "queue", onDeliveryChange, steeringEnabled, polishing, onPolish, running, stopping, onInterrupt, canSend, sending,
  imagesBusy, queuePaused, queueCount, onSend, onAttach, onMention, onCommand,
}: {
  controls?: ReactNode; delivery?: CcInputMode; onDeliveryChange?: (value: CcInputMode) => void; steeringEnabled?: boolean;
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
  const [sendOptionsOpen, setSendOptionsOpen] = useState(false); const sendAnchor = useRef<HTMLButtonElement>(null);
  const queued = running || (queuePaused && queueCount > 0);
  const label = sending ? "发送中" : imagesBusy ? "处理图片" : running && delivery === "steer" ? "补充发送" : running && delivery === "now" ? steeringEnabled ? "立即调整" : "停止后发送" : queued ? "排队发送" : "发送";
  return (
    <div className="cc-composer-tools">
      <div className="cc-composer-input-tools">
        <button ref={extrasAnchor} type="button" className="cc-composer-add" aria-label="添加内容" aria-expanded={extrasOpen} onClick={() => setExtrasOpen(!extrasOpen)}><Icon name="plus" size={16} /><span>添加内容</span></button>
        {extrasOpen && <ChatPopover anchorRef={extrasAnchor} label="添加内容" onClose={() => setExtrasOpen(false)} width={240}>
          <button type="button" className="cc-chat-menu-item" onClick={() => { setExtrasOpen(false); onAttach(); }}><Icon name="image" size={16} />添加图片</button>
          {onPolish && <button type="button" className="cc-chat-menu-item" disabled={polishing || !canSend || sending} onClick={() => { setExtrasOpen(false); onPolish(); }}><Icon name={polishing ? "spinner" : "paintbrush"} size={16} />{polishing ? "正在润色草稿" : "润色草稿"}</button>}
        </ChatPopover>}
        <button type="button" className="cc-composer-direct" aria-label="引用文件" onClick={onMention}><span aria-hidden="true">@</span><span className="cc-composer-direct-label">文件</span></button>
        <button type="button" className="cc-composer-direct" aria-label="查看命令" onClick={onCommand}><Icon name="terminal" size={14} /><span className="cc-composer-direct-label">命令</span></button>
      </div>
      {controls && <div className="cc-composer-config">{controls}</div>}
      <div className="cc-composer-send-tools">
        {running && onInterrupt && <button type="button" className="cc-composer-stop" aria-label={stopping ? "正在停止本轮" : "停止本轮"} disabled={stopping} onClick={onInterrupt} title="停止本轮并暂停发送队列，排队内容保留"><Icon name="pause" size={14} /><span>{stopping ? "停止中" : "停止本轮"}</span></button>}
        {running && onDeliveryChange && <button ref={sendAnchor} className="cc-chat-icon" type="button" aria-label="选择发送方式" disabled={sending} aria-expanded={sendOptionsOpen} onClick={() => setSendOptionsOpen(!sendOptionsOpen)}><Icon name="chevronDown" size={13}/></button>}
        {sendOptionsOpen && <ChatPopover anchorRef={sendAnchor} label="发送方式" width={320} onClose={() => setSendOptionsOpen(false)}>
          {(steeringEnabled ? [
            ["steer", "补充当前任务", "默认方式 · 工具完成后读取，延续当前工作"],
            ["now", "立即调整方向", "优先转后台；否则中断当前执行后补充"],
            ["queue", "下一轮发送", "当前任务结束后，按队列顺序发送"],
          ] : [["queue", "排队发送", "本轮结束后发送"], ["now", "停止后发送", "确认停止后发送，旧队列暂停"]]).map(([mode, title, hint]) => <button key={mode} type="button" className="cc-chat-menu-item" aria-pressed={delivery === mode} onClick={() => { onDeliveryChange?.(mode as CcInputMode); setSendOptionsOpen(false); }}><Icon name="check" size={14} className={delivery === mode ? "text-primary" : "opacity-0"} /><span>{title}<small className="block text-muted-foreground">{hint}</small></span></button>)}
          <p className="cc-chat-note">{steeringEnabled ? "立即调整不会撤销已完成的操作；发送后可查看接收与处理回执。" : "停止不会撤销已完成的操作。"}</p>
        </ChatPopover>}
        <button type="button" data-cc-send className="cc-composer-send" disabled={!canSend || sending || imagesBusy || stopping} onClick={onSend} aria-label={label} title={delivery === "steer" && running ? "补充当前任务，在下一个工具边界读取" : delivery === "now" && running ? "立即调整当前执行方向" : queued ? "加入下一轮队列，暂停时需手动继续" : undefined}><span>{label}</span><Icon name={sending || imagesBusy ? "spinner" : "arrowUp"} size={16} className={sending || imagesBusy ? "animate-spin" : undefined} /></button>
      </div>
    </div>
  );
}

export function ComposerFooter({ sendHint, children, steering }: { sendHint: string; children?: ReactNode; steering?: boolean }) {
  const sendKey = useSendKey();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="cc-composer-footer">
      <button type="button" ref={anchorRef} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="设置发送快捷键" className="rounded text-left hover:text-foreground">{steering ? `${sendKey === "enter" ? "Enter 补充 · " : ""}${sendHint} 立即调整 · Shift Enter 换行` : sendKey === "enter" ? "Enter 发送 · Shift Enter 换行" : `${sendHint} 发送 · Enter 换行`}</button>
      {children}
      {open && <ChatPopover anchorRef={anchorRef} onClose={() => setOpen(false)} label="输入偏好" width={290}>
        <div className="cc-chat-section"><strong>发送快捷键</strong></div>
        {(["enter", "ctrlEnter"] as SendKey[]).map(value => <button type="button" className="cc-chat-menu-item" key={value} aria-pressed={value === sendKey} onClick={() => { setSendKey(value); setOpen(false); }}><Icon name="check" size={15} className={value === sendKey ? "text-primary" : "opacity-0"} /><span>{value === "enter" ? "Enter 发送" : `${sendHint} 发送`}<small className="block text-muted-foreground">{value === "enter" ? "Shift + Enter 换行" : "Enter 换行"}</small></span></button>)}
      </ChatPopover>}
    </div>
  );
}
