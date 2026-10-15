import { memo } from "react";
import type { StaticStatus } from "../../lib/types";
import type { SettingsSection } from "../../lib/settingsSections";
import { Icon, type IconName } from "../ui/icon";
import { APP_INFO } from "../../lib/about";
import { UpdateBadge } from "./UpdateBadge";
import { SideNavSettings } from "./SideNavSettings";

type NavItem = { key: string; label: string; icon: IconName };

/**
 * 工作区导航项。
 *
 * 🔴 数组顺序即 Ctrl+1~4 的映射顺序 —— App.tsx 直接复用本数组生成快捷键表，
 *    改顺序/增删项只改这一处，避免「侧栏顺序」与「快捷键顺序」两处漂移。
 */
export const WORKSPACE_NAV: NavItem[] = [
  { key: "connect", label: "连接", icon: "plug" },
  { key: "terminal", label: "终端", icon: "terminal" },
  { key: "security", label: "安全", icon: "shield" },
  { key: "log", label: "日志", icon: "log" },
];

/**
 * 左侧主导航栏（2026-10-14 由顶部 TabsList 改造而来）。
 *
 * 承载：品牌区（拖拽区）、4 项工作区导航、设置入口（带更新未读红点）、
 * 底部服务状态胶囊（点击可跳到对应处置页）。
 *
 * 安全徽章（白名单关闭 / IP 已变化 / 远程不可达 / 只读 / 命令执行）**不在这里**：
 * 最多 5 枚，200px 宽的侧栏塞不下，仍留在顶栏。
 */
function SideNavImpl({
  activeTab,
  onNavigate,
  unreadCount,
  status,
  collapsed,
  settingsSections,
  settingsActiveId,
  onSelectSection,
  onBackFromSettings,
}: {
  activeTab: string;
  onNavigate: (tab: string, anchor?: string) => void;
  unreadCount: number;
  status?: StaticStatus;
  collapsed: boolean;
  /** 设置目录模式（B 方案，2026-10-15）：activeTab 为 settings 时主侧栏整体
      切换为「返回工作区 + 搜索过滤 + 簇分组导航」。目录数据由 App 层按平台
      过滤后传入（与 SettingsTab 渲染的卡片一一对应）。 */
  settingsSections?: SettingsSection[];
  /** scrollspy 上报的当前高亮卡 id（App 层持有，SettingsTab 上报）。 */
  settingsActiveId?: string;
  onSelectSection?: (id: string, anchor?: string) => void;
  /** 返回工作区：App 决定回到离开设置前的工作区 tab。 */
  onBackFromSettings?: () => void;
}) {
  // 服务状态口径与改造前的 Header 完全一致：
  // 启动失败 / 链路中断 = 红，防火墙未放行 = 橙，已停止 = 灰，正常 = 绿。
  // S5: 未知态（轮询间隙 / 首帧）一律按未运行显示，避免 `?? true` 制造「总在运行」的错觉。
  const running = status?.running ?? false;
  const startupError = status?.startupError ?? null;
  const linkDown = !!status && running && (!!status.ipChanged || status.remoteReachable === false);
  const firewallBlocked =
    !!status &&
    running &&
    !linkDown &&
    status.firewallEnabled === true &&
    status.firewallPortOpen === false;

  const statusTone = startupError || linkDown ? "bad" : !running ? "idle" : firewallBlocked ? "warn" : "ok";
  const statusText = !status
    ? "连接中"
    : startupError
    ? "启动失败"
    : !running
    ? "已停止"
    : linkDown
    ? "远程连接中断"
    : firewallBlocked
    ? "远程未确认"
    : "本机服务运行中";
  const statusTarget = startupError ? "settings" : linkDown || firewallBlocked ? "connect" : null;
  const statusTitle = startupError
    ? "服务启动失败，点击前往设置查看"
    : linkDown
    ? "网络地址已失效，远程连接中断，点击前往连接页"
    : firewallBlocked
    ? "本机服务正常，但防火墙可能拦截远程入站，点击前往连接页"
    : statusText;

  const unreadLabel = unreadCount > 9 ? "9+" : String(unreadCount);

  // 设置目录模式：进设置页时侧栏整体切换为设置目录（返回 + 搜索 + 簇导航）。
  // 状态胶囊两种模式都保留（链路状态不该因为进设置而消失）。
  const settingsMode = activeTab === "settings" && !!settingsSections && !!onSelectSection;

  return (
    <aside className="app-side" data-collapsed={collapsed || undefined} data-mode={settingsMode ? "settings" : undefined}>
      {/* 品牌区：整块可拖窗口（decorations:false，无系统标题栏，必须留出拖拽区域） */}
      <div data-tauri-drag-region className="app-side-head">
        <img
          data-tauri-drag-region
          src="/icon.png"
          alt={APP_INFO.name}
          width={28}
          height={28}
          className="app-side-logo"
          draggable={false}
        />
        <div data-tauri-drag-region className="app-side-brand">
          <span className="app-side-name">{APP_INFO.name}</span>
          <UpdateBadge currentVersion={status?.version} />
        </div>
      </div>

      {settingsMode ? (
        <SideNavSettings
          sections={settingsSections}
          activeId={settingsActiveId ?? ""}
          onSelect={onSelectSection}
          onBack={onBackFromSettings ?? (() => onNavigate("connect"))}
          collapsed={collapsed}
        />
      ) : (
        <nav className="app-side-nav" aria-label="主导航">
          {WORKSPACE_NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className="app-side-item"
              data-active={activeTab === item.key || undefined}
              aria-current={activeTab === item.key ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <Icon name={item.icon} size={16} className="app-side-icon" />
              <span className="app-side-label">{item.label}</span>
            </button>
          ))}
        </nav>
      )}

      <div className="app-side-foot">
        {/* 设置排最末位（导航末位惯例：VS Code / Discord / Telegram 均如此）——
            与「干活的页面」在视觉上分层。进设置的副作用（标已读 / 开更新历史）
            在 App.tsx 的 handleNavigate 里，这里只管导航。
            目录模式下隐藏本入口（已在设置里，出口是「返回工作区」）。 */}
        {!settingsMode && (
          <button
            type="button"
            className="app-side-item"
            data-active={activeTab === "settings" || undefined}
            aria-current={activeTab === "settings" ? "page" : undefined}
            title={collapsed ? `设置${unreadCount > 0 ? `（${unreadCount} 项新更新）` : ""}` : undefined}
            onClick={() => onNavigate("settings")}
          >
            <Icon name="settings" size={16} className="app-side-icon" />
            <span className="app-side-label">设置</span>
            {/* changelog-dot：沿用更新未读红点的脉冲动画 + hover 放大（index.css 已有定义） */}
            {unreadCount > 0 && (
              <span className="app-side-badge changelog-dot" title={`${unreadCount} 项新更新`}>
                {unreadLabel}
              </span>
            )}
          </button>
        )}

        {/* 服务状态：可点击时跳到处置页（启动失败→设置，链路中断 / 防火墙→连接页） */}
        <button
          type="button"
          className="app-side-status status-pill"
          data-tone={statusTone}
          title={statusTitle}
          data-clickable={statusTarget ? true : undefined}
          onClick={() => statusTarget && onNavigate(statusTarget)}
        >
          <span className={`app-side-status-dot ${statusTone === "ok" ? "p-dot" : ""}`} />
          <span className="app-side-status-text">{statusText}</span>
        </button>
      </div>
    </aside>
  );
}

export const SideNav = memo(SideNavImpl);
