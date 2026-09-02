import { useEffect, useRef } from "react";
import { Icon } from "../ui/icon";
import type { TerminalSearch } from "./useTerminalSearch";

/**
 * 终端搜索条：右上角**浮层**。
 *
 * WHY 浮层而不是占一行的工具条：占一行会改变终端容器高度 → 触发 fit →
 * 把新的 rows 发给远端 PTY。也就是说「打开搜索框」这个纯本地动作会让远端 TUI 重排一次，
 * 关掉又重排一次。浮层不改布局，没这个副作用。
 */
export function SshTerminalFind({ search }: { search: TerminalSearch }) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开即聚焦并全选：再按一次 Ctrl+Shift+F 能直接换关键词。
  useEffect(() => {
    if (!search.open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [search.open]);

  if (!search.open) return null;

  const { result, query } = search;
  const label = !query ? "" : result.count === 0 ? "无结果" : `${result.index + 1} / ${result.count}`;

  return (
    <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-lg">
      <input
        ref={inputRef}
        value={query}
        placeholder="搜索终端内容"
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Esc 只在搜索框聚焦时关窗——终端聚焦时 Esc 必须原样发给远端（vim / Claude Code 靠它）。
          if (e.key === "Escape") {
            e.preventDefault();
            search.close();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) search.findPrev();
            else search.findNext();
          }
        }}
        className="h-6 w-36 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
      />
      <span className="min-w-[46px] text-center font-mono text-[10.5px] text-muted-foreground">
        {label}
      </span>
      <FindBtn title="上一个（Shift+Enter）" onClick={search.findPrev}>
        <Icon name="chevronDown" size={12} style={{ transform: "rotate(180deg)" }} />
      </FindBtn>
      <FindBtn title="下一个（Enter）" onClick={search.findNext}>
        <Icon name="chevronDown" size={12} />
      </FindBtn>
      <FindBtn title="区分大小写" active={search.caseSensitive} onClick={search.toggleCase}>
        <span className="text-[10px] font-semibold leading-none">Aa</span>
      </FindBtn>
      <FindBtn title="正则表达式" active={search.regex} onClick={search.toggleRegex}>
        <span className="font-mono text-[10px] leading-none">.*</span>
      </FindBtn>
      <FindBtn title="关闭（Esc）" onClick={search.close}>
        <Icon name="close" size={12} />
      </FindBtn>
    </div>
  );
}

function FindBtn({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted ${
        active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
