import { useEffect, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, listen } from "./lib/tauri";
import type { StatusResponse } from "./lib/types";
import { APP_INFO } from "./lib/about";
import { Header } from "./components/layout/Header";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Button } from "./components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { Icon } from "./components/ui/icon";
import { ToastProvider, useToast } from "./components/ui/toast";
import { ConnectTab } from "./components/tabs/ConnectTab";
import { SecurityTab } from "./components/tabs/SecurityTab";
import { SettingsTab } from "./components/tabs/SettingsTab";
import { LogTab } from "./components/tabs/LogTab";
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

  // 应用重启后用上次确认过的 IP 回填，避免每次都从空开始
  useEffect(() => {
    if (!selectedIp && status?.lastSelectedIp) {
      setSelectedIp(status.lastSelectedIp);
    }
  }, [status?.lastSelectedIp]);

  const queryClient = useQueryClient();

  // 无论自动默认选中还是手动点选,都经过这层落盘,作为下次判断地址变化的基线
  const handleSelectIp = (ip: string) => {
    setSelectedIp(ip);
    if (!ip) return;
    invoke("set_selected_ip", { ip })
      .then(() => {
        // O2: 落盘成功后乐观更新缓存,立即消除 IP 变化警告,无需等下一次 5s 轮询
        queryClient.setQueryData<StatusResponse>(["status"], (old) =>
          old ? { ...old, ipChanged: false, lastSelectedIp: ip } : old,
        );
      })
      // O3: 原 .catch(() => {}) 会静默吞掉写入失败,导致"标记已处理"无效却无提示
      .catch((e) => console.error("[cc-bridge] 保存选中 IP 失败:", e));
  };

  // 首次使用引导
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (status && !isOnboardingDone()) {
      setShowOnboarding(true);
    }
  }, [status]);

  // 命令面板 (Ctrl+K)
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [activeTab, setActiveTab] = useState("connect");
  // 安全徽章点击带入的定位锚点（带 nonce 以便重复点击同一徽章也能重新触发高亮）
  const [pendingAnchor, setPendingAnchor] = useState<{ anchor: string; nonce: number } | null>(null);
  const handleNavigate = useCallback((tab: string, anchor?: string) => {
    setActiveTab(tab);
    setPendingAnchor(anchor ? { anchor, nonce: Date.now() } : null);
  }, []);

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

  // 托盘「复制连接命令」菜单：Rust 端 emit 事件，前端执行复制并反馈（复用 navigator.clipboard + toast）
  const TrayCopyListener = () => {
    const { toast } = useToast();
    useEffect(() => {
      let unlisten: (() => void) | undefined;
      listen<null>("copy-connect-command", async () => {
        try {
          const s = await invoke<StatusResponse>("get_status");
          if (s.connectCommand) {
            await navigator.clipboard.writeText(s.connectCommand);
            toast("连接命令已复制到剪贴板", "success");
          }
        } catch {
          toast("复制失败，请手动复制", "error");
        }
      }).then((fn) => { unlisten = fn; });
      return () => unlisten?.();
    }, [toast]);
    return null;
  };

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
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-5 pb-3 pt-4">
          <TabsList>
            <TabsTrigger value="connect"><Icon name="plug" /> 连接</TabsTrigger>
            <TabsTrigger value="security"><Icon name="shield" /> 安全</TabsTrigger>
            <TabsTrigger value="settings"><Icon name="settings" /> 设置</TabsTrigger>
            <TabsTrigger value="log"><Icon name="log" /> 日志</TabsTrigger>
          </TabsList>
        </div>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-5">
          <TabsContent value="connect">
            <ConnectTab status={status} onRefresh={refetchStatus} selectedIp={selectedIp} onSelectIp={handleSelectIp} />
          </TabsContent>
          <TabsContent value="security">
            <SecurityTab status={status} onSaved={refetchStatus} />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab status={status} onSaved={refetchStatus} highlightAnchor={pendingAnchor} />
          </TabsContent>
          <TabsContent value="log">
            <LogTab />
          </TabsContent>
        </main>
      </Tabs>

      {/* 首次使用引导 */}
      {showOnboarding && (
        <OnboardingGuide onClose={() => setShowOnboarding(false)} />
      )}

      {/* 命令面板 */}
      {showCommandPalette && (
        <CommandPalette
          onClose={() => setShowCommandPalette(false)}
          onNavigate={handleNavigate}
          status={status}
          onChanged={refetchStatus}
        />
      )}

      {/* 托盘复制命令监听（无 UI，仅处理事件） */}
      <TrayCopyListener />
    </div>
    </ToastProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
