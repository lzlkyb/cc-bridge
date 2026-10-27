import type { RefObject } from "react";
import { ChatPopover } from "./ChatPopover";

export function ComposerPolishPreview({ text, onCancel, onApply, anchorRef }: {
  text: string;
  onCancel: () => void;
  onApply: () => void;
  anchorRef: RefObject<HTMLElement>;
}) {
  return <ChatPopover anchorRef={anchorRef} onClose={onCancel} label="润色后的草稿" width={440}>
    <div className="cc-chat-section">
      <strong>润色后的草稿</strong>
      <p className="cc-chat-note">采用后替换输入框，发送前仍可修改。</p>
      <div className="cc-composer-polish-preview">{text}</div>
      <div className="cc-composer-edit-actions"><button type="button" onClick={onCancel}>保留原稿</button><button type="button" onClick={onApply}>采用这版</button></div>
    </div>
  </ChatPopover>;
}
