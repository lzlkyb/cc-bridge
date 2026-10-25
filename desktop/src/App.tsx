import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "./lib/tauri";
import type { StatusResponse, StaticStatus } from "./lib/types";
import { APP_INFO, CHANGELOG } from "./lib/about";
import {
  getLastSeenVersion,
  setLastSeenVersion,
  countUnreadVersions,
  isEditableTarget,
} from "./lib/utils";
import type { SettingsSection } from "./lib/settingsSections";
import { SETTINGS_CATEGORIES } from "./lib/settingsCategories";
import { settingsSectionForAnchor } from "./lib/settingsNavigation";
import { transitionPage } from "./lib/pageTransition";
import { isWindows } from "./lib/platform";
import { Header } from "./components/layout/Header";
import { SideNav, WORKSPACE_NAV } from "./components/layout/SideNav";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAppHiddenFlag } from "./hooks/useAppHiddenFlag";
import { useIpSedCopy } from "./hooks/useIpSedCopy";
import { useWindowSizePersistence } from "./hooks/useWindowSizePersistence";
import { useScrollActivity } from "./hooks/useScrollActivity";
import { usePageInertia } from "./hooks/usePageInertia";
import { useAppHidden } from "./lib/appVisibility";
import { Button } from "./components/ui/button";
import { Tabs, TabsContent } from "./components/ui/tabs";
import { ToastProvider, useToast, toast } from "./components/ui/toast";
import { ActionCard } from "./components/ui/notice";
import { ConnectTab } from "./components/tabs/ConnectTab";
import { Skeleton } from "./components/ui/Skeleton";
// 非首屏 Tab 懒加载：减小首屏 JS，切到对应 Tab 时才加载（fallback 用骨架屏）
const SecurityTab = lazy(() => import("./components/tabs/SecurityTab").then((m) => ({ default: m.SecurityTab })));
const SettingsTab = lazy(() => import("./components/tabs/SettingsTab").then((m) => ({ default: m.SettingsTab })));
const LogTab = lazy(() => import("./components/tabs/LogTab").then((m) => ({ default: m.LogTab })));
const TerminalTab = lazy(() => import("./components/tabs/TerminalTab").then((m) => ({ default: m.TerminalTab })));
// 实验功能（2026-10-24）：CC 对话页。懒加载，未进入本页的用户不承担这部分体积。
const CcGuiTab = lazy(() => import("./components/tabs/CcGuiTab").then((m) => ({ default: m.CcGuiTab })));
import { OnboardingGuide, isOnboardingDone } from "./components/modals/OnboardingGuide";
import { CommandPalette } from "./components/modals/CommandPalette";
import { UpgradeWelcomeBar } from "./components/update/UpgradeWelcomeBar";
import "./terminal-workspace.css";

function AppContent() {
  // 窗口收进托盘/最小化时给 <html> 打 data-app-hidden，暂停全部 CSS 动画。
  // WebView2 不会自己为隐藏窗口节流动画，实测不做这事会白烧约 0.6 个 CPU 核。
  useAppHiddenFlag();
  // 窗口尺寸持久化：启动恢复上次尺寸 + resize 防抖落盘（纯前端方案）
  useWindowSizePersistence();
  const handleScrollActivity = useScrollActivity();
  usePageInertia();
  // 窗口不可见时停掉全部定时轮询（本层 5s / 日志 10s / 防火墙 30s / 后台命令 3s）。
  // 最重的是本层：`get_status` 里带一次可达性探针（真开 TCP 连接，200ms 超时）。
  const appHidden = useAppHidden();

  // 分层订阅：本层只要「剔掉高频字段」的部分，使其引用在 uptime/stats 变化时保持稳定，
  // 下游 `memo(Header)` / `memo(ConnectTab)` 才真正生效（否则顶层引用每 5s 必换，memo 形同虚设）。
  // 实时数字由唯一需要它们的 ConnectHero 自己订阅同一个 queryKey（共享缓存，不多发请求）。
  const { data: status, refetch: refetchStatus, isError: statusError } = useQuery<
    StatusResponse,
    Error,
    StaticStatus
  >({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    refetchInterval: appHidden ? false : 5000,
    select: ({ uptimeSeconds: _uptime, stats: _stats, ...rest }) => rest,
  });

  // 从隐藏恢复到可见时立即补一次，而不是干等下一个 5s 周期（否则刚打开窗口
  // 看到的是旧数据）。用 ref 做跃迁检测：只在 hidden → visible 那一刻刷，
  // 首次挂载（appHidden 本就是 false）不重复发请求。
  const wasHiddenRef = useRef(false);
  useEffect(() => {
    if (wasHiddenRef.current && !appHidden) void refetchStatus();
    wasHiddenRef.current = appHidden;
  }, [appHidden, refetchStatus]);

  // IP 选择状态提升到 App 层，避免切 Tab 时 ConnectTab 卸载导致选中丢失
  const [selectedIp, setSelectedIp] = useState<string>("");

  // 方案 Q: 追踪"用户已点选新地址、但尚未复制远程更新命令"的中间态。
  // O2 乐观更新会在落盘成功后立即把 ipChanged 置 false，导致 IpChangedBanner（含 sed
  // 命令块）在点选瞬间被卸载。用这个状态兜底，让 banner + sed 保持可见，直到用户复制了
  // 远程更新命令（onSedResolved 收口）才随轮询自然消失。
  const [ipResolvedByUser, setIpResolvedByUser] = useState(false);

  // 方案 R: 用户点关闭后「本次会话忽略此 IP 变化提示」的中间态（App 层提升）。
  const [ipChangeDismissed, setIpChangeDismissed] = useState(false);

  // 应用重启后用上次确认过的 IP 回填，避免每次都从空开始
  useEffect(() => {
    if (!selectedIp && status?.lastSelectedIp) {
      setSelectedIp(status.lastSelectedIp);
    }
  }, [status?.lastSelectedIp, selectedIp]);

  const queryClient = useQueryClient();

  // 无论自动默认选中还是手动点选,都经过这层落盘,作为下次判断地址变化的基线
  // useCallback 稳定化：供链路状态跃迁 effect 安全引用，避免每次渲染重建导致 effect 误触发
  // byUser: 用户主动点选(默认 true)时置 ipResolvedByUser，保持 banner+sed 可见；
  //         S4 自动恢复(false)不置位，避免网络恢复后误弹 sed banner。
  // 🔴 弹横幅的判据（审查 B9 修订，2026-10-18）：原 B9 闸门 `byUser && ipChanged`
  // 误伤了「在两个都存活的 IP 之间切换」——后端 ip_changed 只判「旧 IP 已从网卡消失」，
  // 活 IP 互切永远不触发，导致用户点新地址后不再出现「复制命令」横幅（v2.9.1 有）。
  // 正确语义：**存在上次确认过的地址基线、且这次点的不是它**，远端就可能还指着旧地址，
  // sed 命令就有价值 → 弹；首装第一次选（无基线，含引导页）→ 静默，B9 的原始目的保留；
  // 重复点同一 IP → 不弹。自动预选 / S4 恢复走 byUser=false，不经过此闸门。
  // 用 ref 读最新值：status 每 5s 轮询换对象，写进 deps 会让本回调不停重建。
  const ipChangedRef = useRef(false);
  useEffect(() => {
    ipChangedRef.current = !!status?.ipChanged;
  }, [status?.ipChanged]);
  const lastSelectedIpRef = useRef<string | null>(null);
  useEffect(() => {
    lastSelectedIpRef.current = status?.lastSelectedIp ?? null;
  }, [status?.lastSelectedIp]);
  const handleSelectIp = useCallback((ip: string, byUser = true) => {
    setSelectedIp(ip);
    if (!ip) return;
    // 方案 Q: 仅用户主动点选新地址时标记"已处理待复制"，让 IpChangedBanner + sed 命令块
    // 在 O2 乐观清除 ipChanged 后仍保持可见，直到复制远程更新命令。
    // 挂起胶囊同步撤下：细条回来了，命令回到横幅承载（两种呈现互斥）。
    if (byUser && (ipChangedRef.current || (!!lastSelectedIpRef.current && lastSelectedIpRef.current !== ip))) {
      setIpResolvedByUser(true);
      setPendingCmd(null);
    }
    invoke("set_selected_ip", { ip })
      .then(async () => {
        // 🔴 先取消在途轮询再写缓存（审查 P2）：5s 轮询的响应可能正好在这一刻落地，
        // 它带的是「写盘前」的旧快照（ipChanged: true），会把乐观值覆盖回去 →
        // 横幅闪回一下又消失。cancelQueries 让在途请求的落地被丢弃，随后的 invalidate
        // 由调用方的 refetch 接管。
        await queryClient.cancelQueries({ queryKey: ["status"] });
        // O2: 落盘成功后乐观更新缓存,立即消除 IP 变化警告,无需等下一次 5s 轮询
        queryClient.setQueryData<StatusResponse>(["status"], (old) =>
          old ? { ...old, ipChanged: false, lastSelectedIp: ip } : old,
        );
      })
      // O3: 原 .catch(() => {}) 会静默吞掉写入失败,导致"标记已处理"无效却无提示
      .catch((e) => toast(`保存选中 IP 失败：${e}`, "error"));
  }, [queryClient]);

  // 方案 Q: 用户复制了远程更新 sed 命令后收口，允许 banner 随乐观状态/下次轮询自然消失。
  // 挂起胶囊（2026-10-17 方案 A）：胶囊复制成功也走这里收口（绿态 1.4s 淡出后卸载）。
  const handleSedResolved = useCallback(() => {
    setIpResolvedByUser(false);
    setPendingCmd(null);
  }, []);

  // 挂起命令（2026-10-17 方案 A，design/2026-10-17-倒计时归零挂起胶囊-设计稿.html）：
  // IP 横幅 60s 倒计时归零且用户还没复制 → 命令升级为顶栏挂起胶囊（Header 中段），
  // 跨页可见、点一下复制；细条收起（内容区零占用）。清除时机全部收口在下面三个
  // 回调 + ipChanged 重新变 true 的 effect：复制成功 / 重选 IP / 忽略 / IP 再变。
  const [pendingCmd, setPendingCmd] = useState<{ ip: string; cmd: string } | null>(null);
  const handleSuspendCmd = useCallback((p: { ip: string; cmd: string }) => setPendingCmd(p), []);

  // 「复制 IP 替换命令」的全局入口（S3 横幅用，2026-10-17）：托盘同款 Rust 生成，
  // 关掉连接页 banner / 人在终端页时也能复制，不用再回连接页。
  const copyIpSed = useIpSedCopy(handleSedResolved);

  // 方案 R: 用户点关闭后仅本次会话隐藏 banner。当出现「新的」地址变化(false→true)时
  // 自动解除隐藏,避免关一次就永久屏蔽后续变化;停留为 true 的轮询不会重复触发重置。
  // 挂起胶囊：IP 重新变化 = 旧命令作废（新 IP 需要新命令），一并清除。
  useEffect(() => {
    if (status?.ipChanged) {
      setIpChangeDismissed(false);
      setPendingCmd(null);
    }
  }, [status?.ipChanged]);
  const handleDismissIpChange = useCallback(() => {
    setIpChangeDismissed(true);
    setPendingCmd(null);
  }, []);


  // 首次使用引导
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (status && !isOnboardingDone()) {
      setShowOnboarding(true);
    }
  }, [status]);
  // H3：重新查看引导（设置页 / 命令面板触发）——只打开弹窗，不清 localStorage。
  const openOnboarding = useCallback(() => setShowOnboarding(true), []);

  // 命令面板 (Ctrl+K)
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [activeTab, setActiveTab] = useState("connect");

  // 分类页常驻，切换目录不丢失正在编辑的表单或终端会话。
  const [settingsActiveId, setSettingsActiveId] = useState<string>(SETTINGS_CATEGORIES[0].id);
  // 目录项按平台过滤（防火墙卡仅 Windows），侧栏与 SettingsTab 共用同一份。
  const settingsSections = useMemo<SettingsSection[]>(
    () => SETTINGS_CATEGORIES.filter((s) => !s.windowsOnly || isWindows(status?.platform)),
    [status?.platform],
  );
  const handleSettingsSelect = useCallback((id: string, anchor?: string) => {
    setSettingsActiveId(id);
    setPendingAnchor({ anchor: anchor ?? id, nonce: Date.now() });
  }, []);

  // 侧栏形态（2026-10-14）：宽窗展开 200px，窄窗自动收成 56px 图标栏。
  // 看板最低可读宽度为 920px；加上侧栏与页面留白后，窄于 1160px 先收起侧栏，
  // 尽量把空间留给固定排列的卡片，而不是过早出现横向滚动。
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [terminalSidebarHost, setTerminalSidebarHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1160px)");
    const apply = () => setSideCollapsed(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  // 安全徽章点击带入的定位锚点（带 nonce 以便重复点击同一徽章也能重新触发高亮）
  const [pendingAnchor, setPendingAnchor] = useState<{ anchor: string; nonce: number } | null>(null);

  // 更新历史未读红点：记录上次看到的最新版本，与 CHANGELOG 最新版比较得出未读数；进「设置」即标记已读。
  const [lastSeen, setLastSeen] = useState<string | null>(() => getLastSeenVersion());
  // 未读基准：优先用「用户上次浏览的版本」，否则回退到「当前运行版本」。
  // 回退到运行版本可消除「软件已是最新版、却每次打开都红点」的问题（localStorage 为空或
  // 未持久化时，不再把全部历史版本算作未读）。
  // 首屏保护：status 尚未加载完成时不把"未知"误判为"全部未读"，避免启动即闪红点。
  const unreadCount = useMemo(
    () => {
      if (!status) return 0;
      return countUnreadVersions(CHANGELOG.map((e) => e.version), lastSeen ?? status.version ?? null);
    },
    [lastSeen, status],
  );
  // 更新历史引导：红点可点击 → 跳设置 + 自动展开关于卡片 + 滚动到更新历史。
  // token 自增作为「打开更新历史」信号，传给 SettingsTab→AboutGroup。
  const [changelogOpenToken, setChangelogOpenToken] = useState(0);

  const markChangelogSeen = useCallback(() => {
    const latest = CHANGELOG[0]?.version;
    if (latest) {
      setLastSeenVersion(latest);
      setLastSeen(latest);
    }
    // 问题 3 根因修复：看完已读即消费「自动展开更新历史」引导信号。
    // 否则 changelogOpenToken 残留 >0，下次进设置页（AboutGroup 重新挂载）即便无红点也会自动展开。
    setChangelogOpenToken(0);
  }, [setChangelogOpenToken]);

  // 进「设置」页即标记已读（持久化 lastSeen），与"自动展开更新历史"引导信号脱钩。
  // 修复"每次进软件设置 tab 都红点"：不再依赖 AboutGroup 停留 3 秒才写 lastSeen。
  const markSeenOnEnter = useCallback(() => {
    const latest = CHANGELOG[0]?.version;
    if (latest) {
      setLastSeenVersion(latest);
      setLastSeen(latest);
    }
  }, []);

  const handleNavigate = useCallback((tab: string, anchor?: string) => {
    const update = () => {
      setActiveTab(tab);
      // 进设置页即标记已读；仅当有未读（红点）时才自动展开「关于卡片/更新历史」引导。
      // 无红点时不展开，恢复"只有小红点才打开关于卡片"的行为。
      if (tab === "settings") {
        const section = anchor ? settingsSectionForAnchor(anchor) : undefined;
        if (section && settingsSections.some(s => s.id === section)) setSettingsActiveId(section);
        else if (!anchor && unreadCount > 0) {
          setSettingsActiveId("set-about");
          setChangelogOpenToken((t) => t + 1);
        }
        markSeenOnEnter();
      }
      setPendingAnchor(anchor ? { anchor, nonce: Date.now() } : null);
    };
    transitionPage(update, activeTab !== tab);
  }, [activeTab, markSeenOnEnter, unreadCount, settingsSections]);

  // 「返回工作区」回到离开设置前的那个工作区 tab（而不是硬编码 connect）。
  // 必须声明在 handleNavigate 之后（引用它）。
  const lastWorkspaceTabRef = useRef("connect");
  useEffect(() => {
    if (activeTab !== "settings") lastWorkspaceTabRef.current = activeTab;
  }, [activeTab]);
  const handleBackFromSettings = useCallback(() => {
    handleNavigate(lastWorkspaceTabRef.current);
  }, [handleNavigate]);

  // 全局键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      if (isCtrlOrMeta && e.key === "k") {
        e.preventDefault();
        // 按住不放会触发键盘重复，每帧 toggle 一次面板就闪开关；只吃首次按下。
        if (!e.repeat) setShowCommandPalette((v) => !v);
      }
      // Ctrl+1~N 切工作区页（N = WORKSPACE_NAV.length，随导航项增减自动跟随）、Ctrl+, 打开设置
      //（桌面应用标准键位，mac 下 ⌘,）；设置排导航末位不占数字位（导航末位惯例，见 VS Code/Discord）。
      // 输入框/可编辑元素聚焦时不拦截，避免覆盖正常输入（如密码、命令参数）
      if (
        isCtrlOrMeta &&
        e.key >= "1" &&
        e.key <= String(WORKSPACE_NAV.length) &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        // 复用侧栏的导航数组，保证「侧栏展示顺序」与「快捷键顺序」永远一致
        const target = WORKSPACE_NAV[parseInt(e.key) - 1];
        if (target) handleNavigate(target.key);
      }
      // 走 handleNavigate 而非 setActiveTab：进设置需触发标已读/开更新历史的副作用
      if (isCtrlOrMeta && e.key === "," && !isEditableTarget(e.target)) {
        e.preventDefault();
        handleNavigate("settings");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNavigate]);

  // 方案 C: 网络变化 / 切回窗口时主动刷新状态，确保连接页 IP 立即更新（不依赖 5s 轮询）。
  useEffect(() => {
    const refresh = () => refetchStatus();
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refetchStatus]);

  return (
    <ToastProvider>
    {/* h-screen flex-col：外壳纵向排布，.app-shell（grid）撑满余下空间；
        顶栏与侧栏固定，仅内容区滚动（横向锁死、纵向可滚）。 */}
    {/* app-boot-fade：接替 index.html 里的首帧骨架屏时做一次很短的淡入，
        磨掉「骨架灰块 → 真实文字」那下硬切换。 */}
    <div data-app-hidden={appHidden || undefined} className="app-boot-fade flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <Tabs value={activeTab} onValueChange={handleNavigate} className="app-shell">
        <SideNav
          activeTab={activeTab}
          onNavigate={handleNavigate}
          unreadCount={unreadCount}
          status={status}
          collapsed={sideCollapsed}
          onTerminalSidebarReady={setTerminalSidebarHost}
          settingsSections={settingsSections}
          settingsActiveId={settingsActiveId}
          onSelectSection={handleSettingsSelect}
          onBackFromSettings={handleBackFromSettings}
        />
        <div className="app-main flex min-h-0 min-w-0 flex-col">
          <Header
            status={status}
            onChanged={refetchStatus}
            onNavigate={handleNavigate}
            onOpenSearch={() => setShowCommandPalette(true)}
            collapsed={sideCollapsed}
            onToggleCollapse={() => setSideCollapsed((v) => !v)}
            pendingCmd={pendingCmd}
            onPendingResolved={handleSedResolved}
            onPendingDismiss={handleDismissIpChange}
          />
      {statusError && (
        <div className="shrink-0 px-5 pt-2">
          <ActionCard
            tone="destructive"
            title="与本地服务失联"
            summary={`无法获取状态，请检查 ${APP_INFO.name} 进程是否在运行。`}
          >
            <Button variant="outline" size="sm" className="h-6 px-2.5 text-xs" onClick={() => refetchStatus()}>
              重试
            </Button>
          </ActionCard>
        </div>
      )}
      {/* S3: 全局链路中断横幅（任意页可见，不只连接页）。与 statusError 并列但语义不同：
          这里是「服务在跑但远程连不回」，statusError 是「连不上本地服务进程」。 */}
      {/* 连接页本身已内联展示等价信息（地址失效→IpChangedBanner+AddressPicker；
          远程不可达→Header 红胶囊+徽章），故在该页不再重复这条全局横幅与「前往连接」按钮（方案 A）。
          批3-1：多设备模式额外认「近期有 401 失败来源」为渲染条件——令牌失效时服务可达、
          TCP 探针是绿的，没有这条就永远弹不出来。多设备关闭时条件与引入前逐字一致（契约）。 */}
      {status &&
        status.running &&
        (status.ipChanged ||
          status.remoteReachable === false ||
          (status.multiDeviceMode && status.authFailureSources > 0)) &&
        activeTab !== "connect" && (
        <div className="shrink-0 px-5 pt-2">
          <ActionCard
            tone="destructive"
            title={status.multiDeviceMode && !status.ipChanged && status.authFailureSources > 0 ? "远程 AI 工具鉴权失败" : "远程连接中断"}
            summary={
              status.ipChanged
                ? "连接地址已失效，远程 AI 工具已断开，请重选地址。"
                : status.multiDeviceMode && status.authFailureSources > 0
                  ? "检测到有连接在用失效的令牌访问本机服务——通常是另一台设备重新生成令牌后，远端配置还没更新。重新执行本机的接入命令即可带上新令牌。"
                  : status.multiDeviceMode
                    ? "本机服务在运行，但远程连不回。多设备模式下，这可能是另一台设备完成了接入（远端配置已指向它）——若要用本机，请在远端重新执行本机的接入命令。"
                    : "本机服务在运行，但远程连不回，请检查本机网络。"
            }
          >
            {/* IP 变化分支直接给「复制命令」（托盘同款 Rust 生成）——不用回连接页、
                即使连接页 banner 被关掉这里也拿得到。多设备模式的远程不可达分支给
                「复制本机接入命令」（多设备模式下 Rust 产物即条目级命令，在远端重跑
                即可把条目指回本机）；关闭模式维持原状：远程不可达无命令可给，只导航。 */}
            {(status.ipChanged || status.multiDeviceMode) && (
              <Button variant="outline" size="sm" className="h-6 px-2.5 text-xs" onClick={() => void copyIpSed()}>
                {status.ipChanged ? "复制命令" : "复制本机接入命令"}
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-6 px-2.5 text-xs" onClick={() => handleNavigate("connect")}>
              前往连接
            </Button>
          </ActionCard>
        </div>
      )}
          <main className="app-main-content min-h-0 min-w-0 flex-1 overflow-hidden px-5 pb-5" data-page={activeTab} data-terminal={activeTab === "terminal" || undefined} onScrollCapture={handleScrollActivity}>
          <TabsContent value="connect" keepMounted className="page-scroll app-content-box h-full overflow-y-auto overflow-x-hidden">
            <ConnectTab status={status} onRefresh={refetchStatus} selectedIp={selectedIp} onSelectIp={handleSelectIp} ipResolvedByUser={ipResolvedByUser} onSedResolved={handleSedResolved} dismissed={ipChangeDismissed} onDismissIpChange={handleDismissIpChange} onNavigate={handleNavigate} pendingSuspended={!!pendingCmd} onSuspendCmd={handleSuspendCmd} onCopySed={copyIpSed} />
          </TabsContent>
          <TabsContent value="security" keepMounted className="page-scroll h-full overflow-y-auto overflow-x-hidden">
            <Suspense fallback={<TabFallback />}>
              {/* highlightAnchor：安全概览 / 白名单目录等锚点（Header 徽章、命令面板、
                  HealthCard 胶囊、设置页安全卡跳转按钮都走这条链路定位高亮）。 */}
              <SecurityTab status={status} onSaved={refetchStatus} highlightAnchor={pendingAnchor} />
            </Suspense>
          </TabsContent>
          <TabsContent value="settings" keepMounted className="app-content-box h-full overflow-hidden">
            <Suspense fallback={<TabFallback />}>
              <SettingsTab status={status} onSaved={refetchStatus} highlightAnchor={pendingAnchor} unreadCount={unreadCount} onReopenOnboarding={openOnboarding} onMarkSeen={markChangelogSeen} changelogOpenToken={changelogOpenToken} sections={settingsSections} activeSection={settingsActiveId} onActiveSectionChange={setSettingsActiveId} onNavigate={handleNavigate} />
            </Suspense>
          </TabsContent>
          <TabsContent value="log" keepMounted className="h-full overflow-hidden">
            <Suspense fallback={<TabFallback />}>
              {/* highlightAnchor 传同一份 pendingAnchor：本页只认 "perf"（展开性能面板）。 */}
              <LogTab highlightAnchor={pendingAnchor} />
            </Suspense>
          </TabsContent>
          {/* 终端常驻挂载：切 app tab 用 CSS 隐藏而非卸载，保活 SSH 会话。
              避免 TabsContent 在 active!==value 时 return null 卸载 TerminalTab、
              导致前端 sessions state 丢失需重新连接。复用 TerminalTab 内部已验证的 display:none 模式。 */}
          <TabsContent value="terminal" keepMounted className="h-full overflow-hidden">
            <Suspense fallback={<TabFallback />}>
              <TerminalTab status={status} sidebarHost={terminalSidebarHost} sidebarCollapsed={sideCollapsed} onSidebarCollapsedChange={setSideCollapsed} onNavigate={handleNavigate} onChanged={refetchStatus} />
            </Suspense>
          </TabsContent>
          {/* CC 对话页（实验）：独立页面，与终端并列。不挂 data-terminal，
              走普通页的 12px 顶部留白，终端的专用布局与保活逻辑一概不受影响。
              2026-10-25（3-1b 多会话）：这里也改常驻挂载。会话列表与「当前是哪一条」
              是前端状态，卸载就没了 —— 切去终端页再回来会只剩一条新会话，而其余
              那几条仍在 Rust 内存里、谁也够不着。Rust 侧本来就是真源（`cc_snapshot`
              可重放），所以常驻**只是**为了不丢侧栏列表，不是为了保活进程。 */}
          <TabsContent value="ccgui" keepMounted className="h-full overflow-hidden">
            <Suspense fallback={<TabFallback />}>
              <CcGuiTab onNavigate={handleNavigate} />
            </Suspense>
          </TabsContent>
          </main>
        </div>
      </Tabs>

      {/* 首次使用引导 */}
      {showOnboarding && (
        <OnboardingGuide
          status={status}
          selectedIp={selectedIp}
          onSelectIp={handleSelectIp}
          onRefresh={refetchStatus}
          onClose={() => setShowOnboarding(false)}
        />
      )}

      {/* 命令面板 */}
      {showCommandPalette && (
        <CommandPalette
          onClose={() => setShowCommandPalette(false)}
          onNavigate={handleNavigate}
          status={status}
          onChanged={refetchStatus}
          onReopenOnboarding={openOnboarding}
        />
      )}

      {/* 升级后首启欢迎条（方案 D）：只在「版本号变了」的那次启动浮出一次，
          补上升级流程缺的那个「结束」。fixed 零占位，不挤压内容区。 */}
      <UpgradeWelcomeBar
        currentVersion={status?.version}
        onOpenHistory={() => handleNavigate("settings")}
      />

      {/* S3+S4: 链路状态跃迁监听（无 UI），弹 Toast + IP 自动恢复闭环 */}
      <LinkStateWatcher status={status} onReselectIp={handleSelectIp} />
    </div>
    </ToastProvider>
  );
}

/** 探针采样确认次数：间隔 5s 的轮询下，连续 2 次 ≈ 10s 才判定「断了/通了」。 */
const CONFIRM_SAMPLES = 2;

/**
 * S3+S4: 追踪链路状态跃迁（断↔通），弹 Toast 并提供 IP 自动恢复闭环。
 * 必须渲染在 ToastProvider 内部才能使用 useToast。无 UI，仅处理副作用。
 */
function LinkStateWatcher({
  status,
  onReselectIp,
}: {
  status: StaticStatus | undefined;
  onReselectIp: (ip: string, byUser?: boolean) => void;
}) {
  const { toast } = useToast();
  const prevLinkDown = useRef<boolean | null>(null);
  // 🔴 探针滞回（审查 P2）：`remoteReachable` 是一次 200ms TCP 探测，一次抖动
  // 就会误报「远程连接已中断」，恢复时又误报「已恢复」并自动重选 IP。
  // 因此探针不可达要**连续 CONFIRM_SAMPLES 次采样**（约 10s）才算断；
  // 而 `ipChanged` 是确定信号（地址列表里真的没有它了），一次即可。
  const lastRawDown = useRef(false);
  const streak = useRef(0);
  useEffect(() => {
    if (!status) return;
    // 服务没在跑：既不报中断也不报恢复，状态归零（避免下次启动误报）。
    if (!status.running) {
      prevLinkDown.current = null;
      lastRawDown.current = false;
      streak.current = 0;
      return;
    }
    // linkDown = 服务在跑，但地址变了或探针不通（远程连不回本机）
    const rawDown = !!status.ipChanged || status.remoteReachable === false;
    if (rawDown === lastRawDown.current) {
      streak.current += 1;
    } else {
      lastRawDown.current = rawDown;
      streak.current = 1;
    }
    // ipChanged 属确定信号，一次就够；只有探针抖动才要求连续确认。
    const need = status.ipChanged ? 1 : CONFIRM_SAMPLES;
    if (streak.current < need) return;

    const confirmed = rawDown;
    const wasDown = prevLinkDown.current;
    prevLinkDown.current = confirmed;
    if (wasDown === null || wasDown === confirmed) return;
    if (confirmed) {
      toast("远程连接已中断，请检查本机网络连接", "error");
    } else {
      // 仅当服务仍在运行时，linkDown→false 才是真正的「网络恢复」；若 running=false
      // 则是用户主动停服，不应误报恢复、更不应自动重启用户刚停掉的服务。
      // S4: 链路由中断恢复（且服务仍在运行）。自动重新选中已记录的 IP。
      toast("网络已恢复，AI 工具可重新连接", "success");
      if (status.lastSelectedIp) {
        // byUser=false: 自动恢复只更新选中/落盘，不触发 IP 变化 banner
        onReselectIp(status.lastSelectedIp, false);
      }
    }
  }, [status, toast, onReselectIp]);
  return null;
}

/** 懒加载 Tab 的占位骨架屏：模拟卡片布局，加载期间微光呼吸 */
function TabFallback() {
  return (
    <div className="space-y-4 p-1">
      <Skeleton className="h-36 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
