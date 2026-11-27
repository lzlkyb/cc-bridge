import { useState } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";

export function ResendTurnButton({ onResend, usedTools, hadImages, compact, disabled }: {
  onResend: () => void;
  usedTools: boolean;
  hadImages: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return <>
    <button type="button" disabled={disabled} className={compact ? "text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50" : "accent"} onClick={() => usedTools || hadImages ? setConfirming(true) : onResend()}
      title={disabled ? "没有可以重新发送的文字" : "把上一条问题作为新消息发送"}>
      {compact ? "再问一次" : <><Icon name="refresh" size={13} /><span className="cc-msg-action-label">再次发送</span></>}
    </button>
    {confirming && <ConfirmDialog title="再次发送上一条问题？" confirmLabel="再次发送"
      description={`${usedTools ? "上一轮用过工具，再次发送可能重复执行命令或修改文件。" : ""}${hadImages ? "这次只发送文字，请按需重新添加原图。" : ""}`}
      onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); onResend(); }} />}
  </>;
}
