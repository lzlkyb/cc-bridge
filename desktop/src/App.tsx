import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "./lib/tauri";
import type { StatusResponse } from "./lib/types";
import { APP_INFO, CHANGELOG } from "./lib/about";
import { getLastSeenVersion, setLastSeenVersion, countUnreadVersions } from "./lib/utils";
import { Header } from "./components/layout/Header";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Button } from "./components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { Icon } from "./components/ui/icon";
import { ToastProvider, useToast, toast } from "./components/ui/toast";
import { ConnectTab } from "./components/tabs/ConnectTab";
import { Skeleton } from "./components/ui/Skeleton";
// 非首屏 Tab 懒加载：减小首屏 JS，切到对应 Tab 时才加载（fallback 用骨架屏）
const SecurityTab = lazy(() => import("./components/tabs/SecurityTab").then((m) => ({ default: m.SecurityTab })));
const SettingsTab = lazy(() => import("./components/tabs/SettingsTab").then((m) => ({ default: m.SettingsTab })));
const LogTab = lazy(() => import("./components/tabs/LogTab").then((m) => ({ default: m.LogTab })));
import { OnboardingGuide, isOnboardingDone } from "./components/modals/OnboardingGuide";
import { CommandPalette } from "./components/modals/CommandPalette";

function AppContent() {
  const { data: status, refetch: refetchStatus, isError: statusError } = useQuery<StatusResponse>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    refetchInterval: 5000,
  });

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
  const handleSelectIp = useCallback((ip: string, byUser = true) => {
    setSelectedIp(ip);
    if (!ip) return;
    // 方案 Q: 仅用户主动点选新地址时标记"已处理待复制"，让 IpChangedBanner + sed 命令块
    // 在 O2 乐观清除 ipChanged 后仍保持可见，直到复制远程更新命令。
    if (byUser) setIpResolvedByUser(true);
    invoke("set_selected_ip", { ip })
      .then(() => {
        // O2: 落盘成功后乐观更新缓存,立即消除 IP 变化警告,无需等下一次 5s 轮询
        queryClient.setQueryData<StatusResponse>(["status"], (old) =>
          old ? { ...old, ipChanged: false, lastSelectedIp: ip } : old,
        );
      })
      // O3: 原 .catch(() => {}) 会静默吞掉写入失败,导致"标记已处理"无效却无提示
      .catch((e) => toast(`保存选中 IP 失败：${e}`, "error"));
  }, [queryClient]);

  // 方案 Q: 用户复制了远程更新 sed 命令后收口，允许 banner 随乐观状态/下次轮询自然消失。
  const handleSedResolved = useCallback(() => setIpResolvedByUser(false), []);

  // 方案 R: 用户点关闭后仅本次会话隐藏 banner。当出现「新的」地址变化(false→true)时
  // 自动解除隐藏,避免关一次就永久屏蔽后续变化;停留为 true 的轮询不会重复触发重置。
  useEffect(() => {
    if (status?.ipChanged) setIpChangeDismissed(false);
  }, [status?.ipChanged]);
  const handleDismissIpChange = useCallback(() => setIpChangeDismissed(true), []);

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
    setActiveTab(tab);
    // 进设置页即标记已读；仅当有未读（红点）时才自动展开「关于卡片/更新历史」引导。
    // 无红点时不展开，恢复"只有小红点才打开关于卡片"的行为。
    if (tab === "settings") {
      if (unreadCount > 0) setChangelogOpenToken((t) => t + 1);
      markSeenOnEnter();
    }
    setPendingAnchor(anchor ? { anchor, nonce: Date.now() } : null);
  }, [markSeenOnEnter, unreadCount]);

  // 全局键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      if (isCtrlOrMeta && e.key === "k") {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      }
      // Ctrl+1~4 切换 Tab
      if (isCtrlOrMeta && e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        const tabs = ["connect", "security", "settings", "log"];
        setActiveTab(tabs[parseInt(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
    {/* h-screen flex-col：Header 与 Tab 栏固定，仅内容区滚动（横向锁死、纵向可滚） */}
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <Header status={status} onChanged={refetchStatus} onNavigate={handleNavigate} />
      {statusError && (
        <div className="shrink-0 px-5 pt-2">
          <div className="flex items-center gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2 text-xs text-destructive">
            <Icon name="alertTriangle" size={14} className="shrink-0" />
            <span className="flex-1">
              <b className="text-foreground">与本地服务失联</b>
              <span className="text-muted-foreground"> · {`无法获取状态，请检查 ${APP_INFO.name} 进程是否在运行。`}</span>
            </span>
            <Button variant="outline" size="sm" className="h-6 px-2.5 text-[11px]" onClick={() => refetchStatus()}>
              重试
            </Button>
          </div>
        </div>
      )}
      {/* S3: 全局链路中断横幅（任意页可见，不只连接页）。与 statusError 并列但语义不同：
          这里是「服务在跑但远程连不回」，statusError 是「连不上本地服务进程」。 */}
      {/* 连接页本身已内联展示等价信息（地址失效→IpChangedBanner+AddressPicker；
          远程不可达→Header 红胶囊+徽章），故在该页不再重复这条全局横幅与「前往连接」按钮（方案 A）。 */}
      {status && status.running && (status.ipChanged || status.remoteReachable === false) && activeTab !== "connect" && (
        <div className="shrink-0 px-5 pt-2">
          <div className="flex items-center gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2 text-xs text-destructive">
            <Icon name="alertTriangle" size={14} className="shrink-0" />
            <span className="flex-1">
              <b className="text-foreground">远程连接中断</b>
              <span className="text-muted-foreground"> · {status.ipChanged ? "连接地址已失效，远程 Claude Code 已断开，请重选地址。" : "本机服务在运行，但远程连不回，请检查本机网络。"} 点击前往连接页处理。</span>
            </span>
            <Button variant="outline" size="sm" className="h-6 px-2.5 text-[11px]" onClick={() => handleNavigate("connect")}>
              前往连接
            </Button>
          </div>
        </div>
      )}
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v);
          // 进设置页即标记已读；仅当有未读（红点）时才自动展开「关于卡片/更新历史」引导。
          if (v === "settings") {
            if (unreadCount > 0) setChangelogOpenToken((t) => t + 1);
            markSeenOnEnter();
          }
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="shrink-0 px-5 pb-3 pt-4">
          <TabsList>
            <TabsTrigger value="connect"><Icon name="plug" /> 连接</TabsTrigger>
            <TabsTrigger value="security"><Icon name="shield" /> 安全</TabsTrigger>
            <TabsTrigger value="settings">
              <span className="relative inline-flex items-center">
                <Icon name="settings" /> 设置
                {unreadCount > 0 && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (activeTab !== "settings") setActiveTab("settings");
                      setChangelogOpenToken((t) => t + 1);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        if (activeTab !== "settings") setActiveTab("settings");
                        setChangelogOpenToken((t) => t + 1);
                      }
                    }}
                    title={`${unreadCount} 项新更新，点击查看更新历史`}
                    className="changelog-dot absolute -right-2.5 -top-1.5 flex h-4 min-w-[16px] cursor-pointer items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold leading-none text-white"
                  >
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </span>
            </TabsTrigger>
            <TabsTrigger value="log"><Icon name="log" /> 日志</TabsTrigger>
          </TabsList>
        </div>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-5">
          <TabsContent value="connect">
            <ConnectTab status={status} onRefresh={refetchStatus} selectedIp={selectedIp} onSelectIp={handleSelectIp} ipResolvedByUser={ipResolvedByUser} onSedResolved={handleSedResolved} dismissed={ipChangeDismissed} onDismissIpChange={handleDismissIpChange} />
          </TabsContent>
          <TabsContent value="security">
            <Suspense fallback={<TabFallback />}>
              <SecurityTab status={status} onSaved={refetchStatus} />
            </Suspense>
          </TabsContent>
          <TabsContent value="settings">
            <Suspense fallback={<TabFallback />}>
              <SettingsTab status={status} onSaved={refetchStatus} highlightAnchor={pendingAnchor} unreadCount={unreadCount} onReopenOnboarding={openOnboarding} onMarkSeen={markChangelogSeen} changelogOpenToken={changelogOpenToken} />
            </Suspense>
          </TabsContent>
          <TabsContent value="log">
            <Suspense fallback={<TabFallback />}>
              <LogTab />
            </Suspense>
          </TabsContent>
        </main>
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

      {/* S3+S4: 链路状态跃迁监听（无 UI），弹 Toast + IP 自动恢复闭环 */}
      <LinkStateWatcher status={status} onReselectIp={handleSelectIp} />
    </div>
    </ToastProvider>
  );
}

/** S3+S4: 追踪链路状态跃迁（断↔通），弹 Toast 并提供 IP 自动恢复闭环。
 * 必须渲染在 ToastProvider 内部才能使用 useToast。无 UI，仅处理副作用。 */
function LinkStateWatcher({
  status,
  onReselectIp,
}: {
  status: StatusResponse | undefined;
  onReselectIp: (ip: string, byUser?: boolean) => void;
}) {
  const { toast } = useToast();
  const prevLinkDown = useRef<boolean | null>(null);
  useEffect(() => {
    if (!status) return;
    // linkDown = 服务在跑，但地址变了或探针不通（远程连不回本机）
    const linkDown = !!status.running && (status.ipChanged || status.remoteReachable === false);
    const wasDown = prevLinkDown.current;
    if (wasDown !== null && wasDown !== linkDown) {
      if (linkDown) {
        toast("远程连接已中断，请检查本机网络连接", "error");
      } else if (status.running) {
        // 仅当服务仍在运行时，linkDown→false 才是真正的「网络恢复」；若 running=false
        // 则是用户主动停服，不应误报恢复、更不应自动重启用户刚停掉的服务。
        // S4: 链路由中断恢复（且服务仍在运行）。自动重新选中已记录的 IP。
        toast("网络已恢复，Claude Code 可重新连接", "success");
        if (status.lastSelectedIp) {
          // byUser=false: 自动恢复只更新选中/落盘，不触发 IP 变化 banner
          onReselectIp(status.lastSelectedIp, false);
        }
      }
    }
    prevLinkDown.current = linkDown;
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
