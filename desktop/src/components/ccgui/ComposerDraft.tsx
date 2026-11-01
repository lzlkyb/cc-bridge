import { useCallback, useLayoutEffect, type KeyboardEvent, type RefObject } from "react";
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
  const resize = useCallback(() => {
    const el = areaRef.current;
    if (!el) return;
    // 从内容测量而非 rows 高度起步；缩窗/侧栏展开也会改变折行。
    el.style.height = "0px";
    const style = getComputedStyle(el);
    const min = Number.parseFloat(style.getPropertyValue("--cc-draft-min")) || 76;
    const max = Number.parseFloat(style.getPropertyValue("--cc-draft-max")) || 168;
    el.style.height = `${Math.max(min, Math.min(el.scrollHeight, max))}px`;
  }, [areaRef]);
  useLayoutEffect(resize, [value, resize]);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [areaRef, resize]);
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
    rows={1} placeholder={placeholder ?? "告诉 Clawd，@文件 /命令"} className="cc-composer-draft" />;
}
