import { useLayoutEffect, useState, memo } from "react";
import type { StaticStatus } from "../../lib/types";
import type { SettingsSection } from "../../lib/settingsSections";
import { Icon, type IconName } from "../ui/icon";
import { Collapse } from "../ui/Collapse";
import { APP_INFO } from "../../lib/about";
import { UpdateBadge } from "./UpdateBadge";
import { UpdateCollapsedDot } from "./UpdateCollapsedDot";
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
  onTerminalSidebarReady,
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
  onTerminalSidebarReady?: (node: HTMLDivElement | null) => void;
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

  // 未读红点 scale 过渡（2026-10-17）：不再条件渲染——硬插入会把「设置」两个字挤一下。
  // 常驻渲染、0 时缩到 0 宽；退场动画期间保留最后一个非零计数（内容瞬间变 0 会在
  // 收缩中闪现「0」）。稳态隐藏时 scale(0)+0 宽，无占位（样式 .app-side-badge--off）。
  const [lastUnread, setLastUnread] = useState(0);
  useLayoutEffect(() => {
    if (unreadCount > 0) setLastUnread(unreadCount);
  }, [unreadCount]);

  // 设置目录模式：进设置页时侧栏整体切换为设置目录（返回 + 搜索 + 簇导航）。
  // 状态胶囊异常态两种模式口径一致（见 foot 区注释）。
  const settingsMode = activeTab === "settings" && !!settingsSections && !!onSelectSection;

  // 服务状态胶囊槽位化（2026-10-17）：异常态出现/消失套 Collapse 行槽位（0fr→1fr），
  // foot 高度从「啪地长高一截」变成 200ms 平滑展开/收起。退场期间保留最后一份异常
  // 快照渲染——收起时若跟着状态变回正常态文案，胶囊会在收缩中闪现「本机服务运行中」。
  const pillShown = statusTone === "bad" || statusTone === "warn";
  const [heldPill, setHeldPill] = useState<{
    tone: string;
    text: string;
    target: string | null;
    title: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (pillShown) setHeldPill({ tone: statusTone, text: statusText, target: statusTarget, title: statusTitle });
  }, [pillShown, statusTone, statusText, statusTarget, statusTitle]);

  return (
    <aside className="app-side" data-collapsed={collapsed || undefined} data-mode={settingsMode ? "settings" : activeTab === "terminal" ? "terminal" : undefined}>
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
          <span className="app-side-tagline">{APP_INFO.tagline}</span>
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

      {/* Keep the portal host mounted when changing pages so the SSH list retains its search state. */}
      <div ref={onTerminalSidebarReady} className="app-terminal-connections" hidden={activeTab !== "terminal"}/>
      <div className="app-side-foot">
        {/* 更新槽位（方案 A 2026-10-16 二次改造）：设置行右端一个**定宽格子**，
            七种状态在同一个格子里原地变形 ⇒ foot 高度恒定、导航区零位移。
            （改前：只要 updateStatus !== "idle" 就插入一整行徽章，把 foot 从
            53.8px 撑到 79.7px、导航区压扁 25.9px —— 用户看到的就是侧栏跳一下。）
            设置目录模式下设置行不存在，槽位单占一行（常驻，idle 也显示版本号），
            高度同样恒定。折叠态由 index.css 的 .update-slot{display:none} 收起。 */}
        {!settingsMode && (
          <div className="app-side-settings-row">
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
              {/* changelog-dot：沿用更新未读红点的脉冲动画 + hover 放大（index.css 已有定义）。
                  无未读时也渲染（--off 缩为零宽），出现/消失都是 scale 过渡。
                  两种模式共用：折叠态被 overlay 的更新状态点盖住时优先级让位（见下）。 */}
              <span
                className={`app-side-badge changelog-dot ${unreadCount > 0 ? "" : "app-side-badge--off"}`}
                title={unreadCount > 0 ? `${unreadCount} 项新更新` : undefined}
              >
                {unreadCount > 0 ? unreadLabel : lastUnread > 0 ? (lastUnread > 9 ? "9+" : String(lastUnread)) : ""}
              </span>
            </button>
            {/* 折叠态更新状态点（UpdateCollapsedDot，2026-10-18）：overlay 按钮，
                覆盖设置按钮右上角（同 changelog-dot 锚点），点状态点=直接执行
                更新动作（一步直达），点齿轮本体仍进设置页。无更新态返回 null，
                未读提示由上方 changelog-dot 承担。展开态不渲染（update-slot 可见）。 */}
            {collapsed && <UpdateCollapsedDot />}
            <UpdateBadge currentVersion={status?.version} />
          </div>
        )}
        {settingsMode && <UpdateBadge currentVersion={status?.version} />}

        {/* 服务状态胶囊（E 方案 2026-10-15）：异常才现。运行中/已停止不渲染——
            绿点脉冲是常驻壁纸、零信息增量，常态反馈由连接页运行卡片与托盘承担；
            启动失败/链路中断（红）、防火墙未放行（橙）自动出现 + 可点击直达处置页。
            两种模式（工作区/设置目录）口径一致：异常时不因进设置而消失。
            2026-10-17：套 Collapse 行槽位平滑展开/收起（见上方 pillShown 注释）。 */}
        <Collapse open={pillShown}>
          {heldPill && (
            <button
              type="button"
              className="app-side-status status-pill"
              data-tone={heldPill.tone}
              title={heldPill.title}
              data-clickable={heldPill.target ? true : undefined}
              onClick={() => heldPill.target && onNavigate(heldPill.target)}
            >
              <span className="app-side-status-dot" />
              <span className="app-side-status-text">{heldPill.text}</span>
            </button>
          )}
        </Collapse>
      </div>
    </aside>
  );
}

export const SideNav = memo(SideNavImpl);
