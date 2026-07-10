import { useState, useEffect, useRef, useMemo } from "react";
import { Icon, type IconName } from "../ui/icon";

interface CommandItem {
  id: string;
  label: string;
  icon: IconName;
  tab?: string;
  shortcut?: string;
}

const commands: CommandItem[] = [
  { id: "tab-connect", label: "连接页", icon: "plug", tab: "connect", shortcut: "Ctrl+1" },
  { id: "tab-security", label: "安全页", icon: "shield", tab: "security", shortcut: "Ctrl+2" },
  { id: "tab-settings", label: "设置页", icon: "settings", tab: "settings", shortcut: "Ctrl+3" },
  { id: "tab-log", label: "日志页", icon: "log", tab: "log", shortcut: "Ctrl+4" },
];

export function CommandPalette({
  onClose,
  onNavigate,
}: {
  onClose: () => void;
  onNavigate: (tab: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q),
    );
  }, [query]);

  // 重置选中项当搜索变化
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[selectedIndex];
      if (item?.tab) {
        onNavigate(item.tab);
        onClose();
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-[15vh]"
      onClick={onClose}
    >
      <div
        className={`mx-4 w-full max-w-md overflow-hidden rounded-xl border bg-card shadow-2xl transition-all duration-200 ${
          visible ? "translate-y-0 opacity-100 scale-100" : "translate-y-2 opacity-0 scale-98"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2.5 border-b px-4 py-3">
          <Icon name="search" size={16} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索页面..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden sm:inline-flex items-center rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[240px] overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">没有匹配结果</p>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                onClick={() => {
                  if (item.tab) {
                    onNavigate(item.tab);
                    onClose();
                  }
                }}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  i === selectedIndex ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted/60"
                }`}
              >
                <Icon name={item.icon} size={15} className="shrink-0" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.shortcut && (
                  <kbd className="text-[10px] font-mono text-muted-foreground">{item.shortcut}</kbd>
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t px-4 py-2">
          <p className="text-[10px] text-muted-foreground">
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono">↑↓</kbd> 导航 ·{" "}
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono">Enter</kbd> 确认 ·{" "}
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono">Esc</kbd> 关闭
          </p>
        </div>
      </div>
    </div>
  );
}
