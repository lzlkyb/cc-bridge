import { useState, useEffect, useMemo, memo } from "react";
import { invoke } from "../../lib/tauri";
import type { StaticStatus } from "../../lib/types";
import { getStoredTheme, toggleTheme } from "../../lib/theme";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";
import { TitleBarControls } from "./TitleBarControls";
import { SecurityBadgeGroup } from "./SecurityBadgeGroup";

/**
 * 应用顶栏（2026-10-14 侧栏改造后，由原「Header」瘦身而来）。
 *
 * 迁移去向：
 *  - 品牌区（logo + 应用名 + 版本徽章）→ `SideNav` 顶部品牌区
 *  - 服务状态胶囊 → `SideNav` 底部（那里有纵向空间放完整文案，且不挤顶栏）
 *  - 安全徽章（最多 5 枚）→ **留在顶栏**：200px 宽的侧栏塞不下五枚徽章
 *  - 新增侧栏折叠 / 展开按钮（图标栏态下这是唯一的展开入口）
 *
 * ⚠️ 组件文件名与导出名仍保持 `Header`，只为把本次结构改造的 diff 限制在必要范围内
 *    （App.tsx 的 import 不必变动）。语义上它就是「顶栏」。
 */
function HeaderImpl({
  status,
  onChanged,
  onNavigate,
  onOpenSearch,
  collapsed,
  onToggleCollapse,
  location,
}: {
  status?: StaticStatus;
  onChanged?: () => void;
  onNavigate?: (tab: string, anchor?: string) => void;
  /** 打开命令面板：给 Ctrl+K 一个可见入口，否则不知道快捷键的人发现不了它。 */
  onOpenSearch?: () => void;
  /** 侧栏当前是否处于图标栏（收起）态。 */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  location?: string;
}) {
  const [dark, setDark] = useState(() => getStoredTheme() === "dark");
  const [busy, setBusy] = useState(false);

  // 主题由 lib/theme 统一管理（命令面板也复用），这里只同步图标状态
  useEffect(() => {
    const onTheme = (e: Event) =>
      setDark((e as CustomEvent<"dark" | "light">).detail === "dark");
    window.addEventListener("themechange", onTheme);
    return () => window.removeEventListener("themechange", onTheme);
  }, []);

  // S5: 未知态(轮询间隙/首帧)一律视为未运行，避免 `?? true` 制造"总在运行"的错觉
  const running = status?.running ?? false;

  // E-P1-10: useMemo 避免每帧重建 badge 数组
  const securityBadges: {
    key: string;
    show: boolean;
    label: string;
    icon: IconName;
    danger: boolean;
    tab: string;
    anchor?: string;
    title: string;
  }[] = useMemo(() => [
    // 三个核心开关的唯一家在安全页（2026-10-13 去重统一）：徽章直达安全页概览锚点。
    { key: "whitelist", show: !!status && !status.whitelistEnabled, label: "白名单关闭", icon: "alertTriangle" as IconName, danger: true, tab: "security", anchor: "sec-overview", title: "白名单已关闭，点击前往安全页开启" },
    { key: "ip", show: !!status?.ipChanged, label: "IP 已变化", icon: "alertTriangle" as IconName, danger: true, tab: "connect", title: "连接地址已变化，点击前往连接页查看" },
    { key: "link", show: !!status?.running && status?.remoteReachable === false && !status?.ipChanged, label: "远程不可达", icon: "alertTriangle" as IconName, danger: true, tab: "connect", title: "远程连接不可达，点击前往连接页查看" },
    { key: "readonly", show: !!status?.readonlyMode, label: "只读", icon: "lock" as IconName, danger: false, tab: "security", anchor: "sec-overview", title: "只读模式已开启，点击前往安全页查看" },
    { key: "shell", show: !!status?.shellEnabled, label: "命令执行已开启", icon: "terminal" as IconName, danger: true, tab: "security", anchor: "sec-overview", title: "命令执行已开启，点击前往安全页关闭" },
  ], [status]);

  const toggleServer = async () => {
    setBusy(true);
    try {
      await invoke(running ? "stop_mcp_server" : "start_mcp_server");
      // 启停后立刻刷新状态；后端 running 标志已同步更新。
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <header
      data-tauri-drag-region
      className="app-header app-topbar flex shrink-0 items-center gap-2 border-b px-3"
    >
      {/* 左侧：侧栏开关 + 安全徽章（徽章仅在异常态出现，正常时这一区很窄） */}
      <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-1.5">
        {onToggleCollapse && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleCollapse}
            title={collapsed ? "展开工作区导航" : "收起工作区导航"}
            aria-label={collapsed ? "展开工作区导航" : "收起工作区导航"}
            aria-expanded={!collapsed}
          >
            {/* 图标集里只有 chevronLeft（无 chevronRight），收起态靠翻转表达 */}
            <Icon name="chevronLeft" size={16} className={collapsed ? "rotate-180" : ""} />
          </Button>
        )}
        <span className="max-w-40 truncate text-xs font-medium text-muted-foreground" data-tauri-drag-region>{location}</span>
        {/* C 方案 2026-10-15：5 枚散徽章聚合为一枚入口——徽章群原紧邻侧栏开关与
            服务启停两个高危邻居，窄窗下弹性空白被压没后直接顶上「停止服务」，
            误触代价重。面板内各项保留完整语义与原跳转逻辑。 */}
        <SecurityBadgeGroup badges={securityBadges} onNavigate={onNavigate} />
      </div>

      {/* 中部：纯拖拽空白（无系统标题栏，需要留足可拖区域） */}
      <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch" />

      {/* 右侧：启停 / 搜索 / 主题 / 窗口控件 */}
      <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-2">
        {status && (
          <Button
            variant={running ? "outline" : "default"}
            size="sm"
            isLoading={busy}
            loadingText={running ? "停止中…" : "启动中…"}
            onClick={toggleServer}
            className="gap-1.5"
          >
            {!busy && <Icon name={running ? "pause" : "play"} size={14} />}
            {!busy && (running ? "停止服务" : "启动服务")}
          </Button>
        )}
        {/* 搜索（命令面板）入口：Ctrl+K 的可见按钮，让搜索能力可被发现 */}
        {onOpenSearch && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSearch}
            title="搜索页面与设置（Ctrl+K）"
            aria-label="搜索（Ctrl+K）"
            className="gap-1.5 text-muted-foreground"
          >
            <Icon name="search" size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => toggleTheme()}
          aria-label={dark ? "切换浅色" : "切换深色"}
        >
          <Icon name={dark ? "sun" : "moon"} size={18} />
        </Button>

        {/* 窗口控件：最小化、最大化、关闭 — 最右侧 */}
        <TitleBarControls />
      </div>
    </header>
  );
}

export const Header = memo(HeaderImpl);
