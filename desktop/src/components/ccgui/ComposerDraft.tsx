import { useEffect, type KeyboardEvent, type RefObject } from "react";
import { isImeComposing } from "../../lib/utils";
import { collectPastedImages } from "./ComposerAttachments";

/** 文本输入的浏览器行为集中在这里：自动增高、图片粘贴和输入法组合保护。 */
export function ComposerDraft({ areaRef, value, placeholder, onChange, onCaret, onImages, onKeyDown }: {
  areaRef: RefObject<HTMLTextAreaElement>;
  value: string;
  placeholder?: string;
  onChange: (text: string, caret: number) => void;
  onCaret: (caret: number) => void;
  onImages: (files: File[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  // 程序回填与粘贴也会改变高度，不只监听键盘输入。
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(76, Math.min(el.scrollHeight, 168))}px`;
  }, [value, areaRef]);
  return <textarea ref={areaRef} aria-label="消息" value={value}
    onChange={event => onChange(event.target.value, event.target.selectionStart)}
    onSelect={event => onCaret(event.currentTarget.selectionStart)}
    onPaste={event => {
      const files = collectPastedImages(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault(); onImages(files);
    }}
    onKeyDown={event => {
      // 组合期间方向键与 Enter 归输入法，不能让补全或发送截走。
      if (!isImeComposing(event.nativeEvent)) onKeyDown(event);
    }}
    rows={3} placeholder={placeholder ?? "给 CC 发消息…"} className="cc-composer-draft" />;
}
