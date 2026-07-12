import { useState, useEffect, useRef, useMemo, Fragment } from "react";
import { Icon, type IconName } from "../ui/icon";
import { useToast } from "../ui/toast";
import { invoke } from "../../lib/tauri";
import { toggleTheme } from "../../lib/theme";
import type { StatusResponse } from "../../lib/types";
import { DirectoryBrowser } from "./DirectoryBrowser";

interface CommandItem {
  id: string;
  label: string;
  icon: IconName;
  group: string;
  shortcut?: string;
  tab?: string;
  run?: () => void | Promise<void>;
}

export function CommandPalette({
  onClose,
  onNavigate,
  status,
  onChanged,
}: {
  onClose: () => void;
  onNavigate: (tab: string) => void;
  status?: StatusResponse;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showDirBrowser, setShowDirBrowser] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runRegenerateToken = async () => {
    try {
      const token = await invoke<string>("regenerate_token");
      await navigator.clipboard.writeText(token).catch(() => {});
      toast("访问令牌已重新生成并复制到剪贴板", "success");
      onChanged?.();
    } catch (e) {
      toast("生成失败：" + String(e), "error");
    }
  };

  const runToggleServer = async () => {
    const running = status?.running ?? true;
    try {
      await invoke(running ? "stop_mcp_server" : "start_mcp_server");
      toast(running ? "MCP 服务已停止" : "MCP 服务已启动", "success");
      onChanged?.();
    } catch (e) {
      toast("操作失败：" + String(e), "error");
    }
  };

  const runRestartServer = async () => {
    try {
      await invoke("restart_mcp_server");
      toast("MCP 服务已重启", "success");
      onChanged?.();
    } catch (e) {
      toast("重启失败：" + String(e), "error");
    }
  };

  const runClearAudit = async () => {
    try {
      await invoke("clear_audit_log");
      toast("审计日志已清空", "success");
      onChanged?.();
    } catch (e) {
      toast("清空失败：" + String(e), "error");
    }
  };

  const handleSelectRoot = async (path: string) => {
    if (!status) return;
    const roots = [...status.allowedRoots, path];
    try {
      await invoke("save_config", { patch: { allowedRoots: roots } });
      toast("已添加根目录：" + path, "success");
      onChanged?.();
    } catch (e) {
      toast("添加失败：" + String(e), "error");
    } finally {
      setShowDirBrowser(false);
      onClose();
    }
  };

  const isDark = document.documentElement.classList.contains("dark");
  const running = status?.running ?? true;

  // E-P1-11: useMemo 避免 11 个 CommandItem 每渲染重建
  const items = useMemo<CommandItem[]>(() => [
    { id: "nav-connect", label: "前往：连接页", icon: "plug", group: "导航", tab: "connect", shortcut: "Ctrl+1" },
    { id: "nav-security", label: "前往：安全页", icon: "shield", group: "导航", tab: "security", shortcut: "Ctrl+2" },
    { id: "nav-settings", label: "前往：设置页", icon: "settings", group: "导航", tab: "settings", shortcut: "Ctrl+3" },
    { id: "nav-log", label: "前往：日志页", icon: "log", group: "导航", tab: "log", shortcut: "Ctrl+4" },
    { id: "act-token", label: "重新生成访问令牌", icon: "key", group: "操作", run: runRegenerateToken },
    { id: "act-server", label: running ? "停止 MCP 服务" : "启动 MCP 服务", icon: running ? "pause" : "play", group: "操作", run: runToggleServer },
    { id: "act-restart", label: "重启 MCP 服务", icon: "refresh", group: "操作", run: runRestartServer },
    { id: "act-clearlog", label: "清空审计日志", icon: "trash", group: "操作", run: runClearAudit },
    { id: "act-addroot", label: "添加允许访问的根目录", icon: "plus", group: "操作", run: () => setShowDirBrowser(true) },
    { id: "act-theme", label: isDark ? "切换到浅色主题" : "切换到深色主题", icon: isDark ? "sun" : "moon", group: "外观", run: toggleTheme },
  ], [running, isDark, runToggleServer, runRestartServer, runRegenerateToken, runClearAudit, setShowDirBrowser, toggleTheme]);

  const filtered = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => c.label.toLowerCase().includes(q));
  })();

  // 重置选中项当搜索变化
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const selectItem = async (item: CommandItem) => {
    if (item.tab) {
      onNavigate(item.tab);
      onClose();
      return;
    }
    if (!item.run) return;
    // 打开目录选择器是子流程，不在此关闭面板
    if (item.id === "act-addroot") {
      item.run();
      return;
    }
    setBusyId(item.id);
    try {
      await item.run();
    } finally {
      setBusyId(null);
      onClose();
    }
  };

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
      if (item) selectItem(item);
    } else if (e.key === "Escape") {
      if (showDirBrowser) return; // 交给 DirectoryBrowser 处理
      onClose();
    }
  };

  let lastGroup = "";

  return (
    <>
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
              placeholder="搜索页面或执行操作..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden sm:inline-flex items-center rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[300px] overflow-y-auto py-1.5">
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">没有匹配结果</p>
            ) : (
              filtered.map((item, i) => {
                const showHeader = item.group !== lastGroup;
                lastGroup = item.group;
                const isBusy = busyId === item.id;
                return (
                  <Fragment key={item.id}>
                    {showHeader && (
                      <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {item.group}
                      </div>
                    )}
                    <button
                      onClick={() => selectItem(item)}
                      onMouseEnter={() => setSelectedIndex(i)}
                      disabled={isBusy}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors disabled:opacity-60 ${
                        i === selectedIndex ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted/60"
                      }`}
                    >
                      <Icon name={item.icon} size={15} className="shrink-0" />
                      <span className="flex-1 text-left">{item.label}</span>
                      {isBusy && <Icon name="spinner" size={14} className="animate-spin" />}
                      {item.shortcut && (
                        <kbd className="text-[10px] font-mono text-muted-foreground">{item.shortcut}</kbd>
                      )}
                    </button>
                  </Fragment>
                );
              })
            )}
          </div>

          {/* Footer hint */}
          <div className="border-t px-4 py-2">
            <p className="text-[10px] text-muted-foreground">
              <kbd className="rounded bg-muted px-1 py-0.5 font-mono">↑↓</kbd> 导航 ·{" "}
              <kbd className="rounded bg-muted px-1 py-0.5 font-mono">Enter</kbd> 执行 ·{" "}
              <kbd className="rounded bg-muted px-1 py-0.5 font-mono">Esc</kbd> 关闭
            </p>
          </div>
        </div>
      </div>

      {showDirBrowser && (
        <DirectoryBrowser
          open
          onClose={() => setShowDirBrowser(false)}
          onSelect={handleSelectRoot}
        />
      )}
    </>
  );
}
