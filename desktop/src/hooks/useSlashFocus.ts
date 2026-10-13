import { useEffect, useRef, type RefObject } from "react";

const isEditable = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement &&
  (el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable);

/**
 * `/` 聚焦搜索框（a11y 快捷键）：页面任意处按 `/`（输入态不劫持——用户正在
 * 别的框里打字时 `/` 是普通字符）把焦点送到指定输入框；焦点在框内按 Esc
 * 清空并失焦。开箱即用零配置，参考浏览器与 GitHub 的站内搜索惯例。
 */
export function useSlashFocus(
  inputRef: RefObject<HTMLInputElement | null>,
  onEscape?: () => void,
): void {
  // 回调走 ref：调用方普遍传内联箭头函数，入 effect 依赖会反复重订阅。
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !isEditable(e.target)) {
        e.preventDefault(); // 拦掉即将打进页面的 `/`
        inputRef.current?.focus();
      } else if (e.key === "Escape" && e.target === inputRef.current) {
        escapeRef.current?.();
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputRef]);
}
