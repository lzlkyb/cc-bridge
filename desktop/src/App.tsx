import { useEffect, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "./lib/tauri";
import type { StatusResponse } from "./lib/types";
import { Header } from "./components/layout/Header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { Icon } from "./components/ui/icon";
import { ToastProvider } from "./components/ui/toast";
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

  return (
    <ToastProvider>
    {/* h-screen flex-col：Header 与 Tab 栏固定，仅内容区滚动（横向锁死、纵向可滚） */}
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <Header status={status} onChanged={refetchStatus} />
      <Tabs defaultValue="connect" className="flex min-h-0 flex-1 flex-col">
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
    </div>
    </ToastProvider>
  );
}

export default App;
