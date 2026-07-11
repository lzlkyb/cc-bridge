import { useEffect, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke, listen } from "./lib/tauri";
import type { StatusResponse } from "./lib/types";
import { Header } from "./components/layout/Header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { Icon } from "./components/ui/icon";
import { ToastProvider, useToast } from "./components/ui/toast";
import { ConnectTab } from "./components/tabs/ConnectTab";
import { SecurityTab } from "./components/tabs/SecurityTab";
import { SettingsTab } from "./components/tabs/SettingsTab";
import { LogTab } from "./components/tabs/LogTab";
import { OnboardingGuide, isOnboardingDone } from "./components/modals/OnboardingGuide";
import { CommandPalette } from "./components/modals/CommandPalette";

function App() {
  const { data: status, refetch: refetchStatus } = useQuery<StatusResponse>({
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

  // 无论自动默认选中还是手动点选，都经过这层落盘，作为下次判断地址变化的基线
  const handleSelectIp = (ip: string) => {
    setSelectedIp(ip);
    if (ip) invoke("set_selected_ip", { ip }).catch(() => {});
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
  const handleSetTab = useCallback((tab: string) => {
    setActiveTab(tab);
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
      <Header status={status} onChanged={refetchStatus} />
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
            <SettingsTab status={status} onSaved={refetchStatus} />
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
          onNavigate={handleSetTab}
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

export default App;
