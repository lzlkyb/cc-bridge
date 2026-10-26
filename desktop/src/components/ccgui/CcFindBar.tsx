import { useEffect, useRef } from "react";
import { isImeComposing } from "../../lib/utils";
import { Icon } from "../ui/icon";

/**
 * 会话内搜索的浮层搜索条（设计稿《对话页-会话内搜索》）。
 *
 * 形态语言与终端搜索条（SshTerminalFind）一致：absolute right-3 top-3 的
 * 浮层 —— **不占布局**，占高度会把正在读的位置顶走、也会干扰贴底判定。
 * 键位同终端：Enter 下一个 / Shift+Enter 上一个 / Esc 关闭（Esc 带 IME 守卫）。
 */
export function CcFindBar({
  query,
  onQuery,
  occ,
  total,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onQuery: (q: string) => void;
  occ: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开即聚焦：再按一次 Ctrl+F 能直接改关键词（select 全选，整词替换）。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const none = total === 0 && query.trim().length > 0;

  return (
    <div className="animate-scale-in absolute right-3 top-3 z-20 flex items-center gap-0.5 rounded-lg border border-border bg-card/95 p-1 shadow-lg">
      <Icon name="search" size={12} className="ml-1 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        aria-label="搜索当前会话"
        placeholder="搜索当前会话…"
        onKeyDown={(e) => {
          // IME 组词中的 Enter/Esc 属于输入法（上屏 / 收候选窗），不翻页、不关条。
          if (isImeComposing(e.nativeEvent)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        className="h-6 w-44 rounded-md bg-transparent px-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span className={`min-w-[46px] text-center text-[11px] tabular-nums ${none ? "text-warning-ink" : "text-muted-foreground"}`}>
        {none ? "无结果" : total > 0 ? `${occ + 1} / ${total}` : ""}
      </span>
      <FindBtn title="上一个（Shift+Enter）" disabled={total === 0} onClick={onPrev}>
        <Icon name="chevronDown" size={12} style={{ transform: "rotate(180deg)" }} />
      </FindBtn>
      <FindBtn title="下一个（Enter）" disabled={total === 0} onClick={onNext}>
        <Icon name="chevronDown" size={12} />
      </FindBtn>
      <FindBtn title="关闭（Esc）" onClick={onClose}>
        <Icon name="close" size={12} />
      </FindBtn>
    </div>
  );
}

function FindBtn({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}
