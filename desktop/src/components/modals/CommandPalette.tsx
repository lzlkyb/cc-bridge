import { useState, useEffect, useRef, useMemo } from "react";
import { Icon } from "../ui/icon";
import { EmptyState } from "../ui/EmptyState";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import { useToast } from "../ui/toast";
import { invoke } from "../../lib/tauri";
import { toggleTheme } from "../../lib/theme";
import { copyText, isImeComposing } from "../../lib/utils";
import type { StaticStatus } from "../../lib/types";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { shortcutLabel } from "../../lib/platform";
import { SETTING_SEARCH_ITEMS } from "../../lib/settingsSearch";
import { WORKSPACE_NAV } from "../layout/SideNav";
import { useDialogDismiss } from "../../hooks/useDialogDismiss";
import { usePresence } from "../../hooks/usePresence";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useIpSedCopy } from "../../hooks/useIpSedCopy";
import {
  preparePaletteItems,
  recentPaletteIds,
  recordPaletteUse,
  searchPalette,
} from "../../lib/paletteSearch";
import { CommandPaletteList, RECENT_GROUP, type CommandItem, type ListEntry } from "./CommandPaletteList";

export function CommandPalette({
  onClose,
  onNavigate,
  status,
  onChanged,
  onReopenOnboarding,
}: {
  onClose: () => void;
  /** 第二个参数传锚点（App.handleNavigate 本来就支持，只是这里的类型之前没开口）。 */
  onNavigate: (tab: string, anchor?: string) => void;
  status?: StaticStatus;
  onChanged?: () => void;
  /** H3：重新打开首次使用引导（不清除 localStorage，仅重新展示）。 */
  onReopenOnboarding?: () => void;
}) {
  const { toast } = useToast();
  const copyIpSed = useIpSedCopy();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showDirBrowser, setShowDirBrowser] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<CommandItem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const listRef = useAutoAnimateRM<HTMLDivElement>();
  const { closing, dismiss } = useDialogDismiss(onClose);
  const { entered } = usePresence(!closing);
  const close = () => dismiss();
  useFocusTrap(surfaceRef, { onEscape: !showDirBrowser && !pendingConfirm ? close : undefined });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runRegenerateToken = async () => {
    try {
      const token = await invoke<string>("regenerate_token");
      // H6 修复：之前 .catch(() => {}) 静默吞掉复制失败，下一行仍会无条件提示"已复制"。
      await copyText(
        token,
        () => toast("访问令牌已重新生成并复制到剪贴板", "success"),
        () => toast("访问令牌已重新生成，但复制到剪贴板失败，请手动复制", "error"),
      );
      onChanged?.();
    } catch (e) {
      toast("生成失败：" + String(e), "error");
    }
  };

  const runToggleServer = async () => {
    // 与 Header S5 对齐：状态未知时当作未运行。
    const running = status?.running ?? false;
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
      close();
    }
  };

  const isDark = document.documentElement.classList.contains("dark");
  // 与 Header S5 对齐：状态未知（status 未加载）时默认当作未运行，避免误导。
  const running = status?.running ?? false;
  // 快捷键标签的平台来源；首帧 status 为 undefined 时先显示 Ctrl（见 lib/platform.ts 的取舍）。
  const platform = status?.platform;

  const items = useMemo<CommandItem[]>(() => [
    // 快捷键标签按平台变（mac 显示 ⌘1）；功能本身早已兼容（App.tsx 键盘监听用 `e.ctrlKey || e.metaKey`），这里仅修正显示。
    ...WORKSPACE_NAV.map((item, index) => ({ id: `nav-${item.key}`, label: `前往：${item.label}页`, icon: item.icon, group: "导航", tab: item.key, shortcut: shortcutLabel(platform, String(index + 1)) })),
    { id: "nav-settings", label: "前往：设置页", icon: "settings", group: "导航", tab: "settings", shortcut: shortcutLabel(platform, ",") },
    {
      id: "act-token",
      label: "重新生成访问令牌",
      icon: "key",
      group: "操作",
      run: runRegenerateToken,
      confirmTitle: "确定重新生成访问令牌？",
      confirmDescription: status?.multiDeviceMode ? "旧令牌立即失效，所有使用旧令牌连接的 AI 工具会需要重新配置。如果你在另一台电脑也接入了同一个 AI 工具，那台机器的连接会一并断开，需要在那台机器上重新执行接入命令。" : "旧令牌立即失效，所有使用旧令牌连接的 AI 工具会需要重新配置。",
    },
    { id: "act-server", label: running ? "停止 MCP 服务" : "启动 MCP 服务", icon: running ? "pause" : "play", group: "操作", run: runToggleServer },
    { id: "act-restart", label: "重启 MCP 服务", icon: "refresh", group: "操作", run: runRestartServer },
    // IP 变化后不用回连接页也能拿命令（全屏终端态下命令面板是唯一可达入口）。
    { id: "act-ipsed", label: "复制 IP 替换命令", icon: "copy", group: "操作", run: copyIpSed, keywords: "ip 地址 替换 sed 修复 重连 中断" },
    {
      id: "act-clearlog", label: "清空审计日志", icon: "trash", group: "操作", run: runClearAudit,
      confirmTitle: "确定清空全部审计日志？", confirmDescription: "此操作会删除本机所有历史调用记录，且不可恢复。",
    },
    { id: "act-addroot", label: "添加允许访问的根目录", icon: "plus", group: "操作", run: () => setShowDirBrowser(true) },
    { id: "act-onboarding", label: "重新查看使用引导", icon: "info", group: "操作", run: () => onReopenOnboarding?.() },
    { id: "act-theme", label: isDark ? "切换到浅色主题" : "切换到深色主题", icon: isDark ? "sun" : "moon", group: "外观", run: toggleTheme },
    // 设置项索引（纯数据，见 lib/settingsSearch.ts）。只跳转、不代操——原因写在那个文件里。
    ...SETTING_SEARCH_ITEMS,
  ], [running, isDark, platform, runToggleServer, runRestartServer, runRegenerateToken, runClearAudit, setShowDirBrowser, toggleTheme, onReopenOnboarding, copyIpSed]);

  // 检索内核在 lib/paletteSearch（设计稿《命令面板-拼音模糊与最近使用》）：
  // 子串 > 子序列 > keywords > 拼音全拼 > 拼音首字母，命中字符加亮、拼音给注音槽。
  // 空查询时「最近使用」（frecency）置顶，其余条目仍按原分组完整出现。
  const q = query.trim();
  const entries = useMemo(() => preparePaletteItems(items), [items]);
  const flat = useMemo<ListEntry[]>(() => {
    const all = searchPalette(entries, q);
    if (q) return all.map((match) => ({ match, displayGroup: match.item.group }));
    const byId = new Map(all.map((m) => [m.item.id, m]));
    const top = recentPaletteIds(items, 5)
      .map((id) => byId.get(id))
      .filter((m): m is (typeof all)[number] => !!m)
      .map((match) => ({ match, displayGroup: RECENT_GROUP }));
    return [...top, ...all.map((match) => ({ match, displayGroup: match.item.group }))];
  }, [entries, items, q]);

  // 重置选中项当搜索变化
  useEffect(() => setSelectedIndex(0), [query]);

  const runItem = async (item: CommandItem) => {
    if (!item.run) return;
    recordPaletteUse(item.id);
    setBusyId(item.id);
    try {
      await item.run();
    } finally {
      setBusyId(null);
      close();
    }
  };

  const selectItem = async (item: CommandItem) => {
    if (closing || busyId) return;
    if (item.tab) {
      recordPaletteUse(item.id);
      onNavigate(item.tab, item.anchor);
      close();
      return;
    }
    if (!item.run) return;
    // 打开目录选择器是子流程，不在此关闭面板
    if (item.id === "act-addroot") {
      recordPaletteUse(item.id);
      item.run();
      return;
    }
    // H1 修复：不可逆/高风险操作先弹 ConfirmDialog，不直接 invoke（之前打字+回车即执行，与同一操作在
    // 正常页面里有确认弹窗不一致）。
    if (item.confirmTitle) {
      setPendingConfirm(item);
      return;
    }
    await runItem(item);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组词中放行：Enter 是上屏、方向键属于候选窗，此时执行选中项会劫持输入法
    if (isImeComposing(e.nativeEvent)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = flat[selectedIndex];
      if (entry) selectItem(entry.match.item);
    } else if (e.key === "Escape") {
      if (showDirBrowser) return; // 交给 DirectoryBrowser 处理
      if (pendingConfirm) return; // 交给 ConfirmDialog 处理
      close();
    }
  };

  return (
    <>
      <div
        className="ui-overlay fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-[15vh] pal-mask"
        data-state={entered ? "open" : "closed"}
        data-exiting={closing || undefined}
        onClick={close}
      >
        <div
          ref={surfaceRef}
          role="dialog" aria-modal="true" aria-label="搜索命令"
          data-state={entered ? "open" : "closed"}
          data-exiting={closing || undefined}
          className="ui-surface mx-4 w-full max-w-md overflow-hidden rounded-xl modal-surface pal"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search input */}
          <div className="flex items-center gap-2.5 border-b px-4 py-3 pal-in">
            <Icon name="search" size={16} className="text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="搜索页面或执行操作..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden sm:inline-flex items-center rounded border bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[300px] overflow-y-auto py-1.5 pal-list">
            {flat.length === 0 ? (
              <EmptyState className="py-6" icon="search" description="没有匹配的结果，换个关键词试试" />
            ) : (
              <CommandPaletteList
                flat={flat}
                selectedIndex={selectedIndex}
                busyId={busyId}
                onSelect={selectItem}
                onHover={setSelectedIndex}
              />
            )}
          </div>

          {/* Footer hint */}
          <div className="border-t px-4 py-2 pal-ft">
            <p className="text-[11px] text-muted-foreground">
              <kbd className="rounded bg-muted px-1 py-0.5 font-mono">↑↓</kbd> 导航 ·{" "}
              <kbd className="rounded bg-muted px-1 py-0.5 font-mono">Enter</kbd> 执行 ·{" "}
              <kbd className="rounded bg-muted px-1 py-0.5 font-mono">Esc</kbd> 关闭 ·{" "}
              <span className="text-primary/85">支持拼音首字母（mx → 模型）</span>
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

      {pendingConfirm && (
        <ConfirmDialog
          title={pendingConfirm.confirmTitle ?? "确认此操作？"}
          description={pendingConfirm.confirmDescription}
          variant="destructive"
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const item = pendingConfirm;
            setPendingConfirm(null);
            void runItem(item);
          }}
        />
      )}
    </>
  );
}
