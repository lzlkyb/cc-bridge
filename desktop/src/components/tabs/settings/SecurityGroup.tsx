import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus, ConfigSaveResult, TlsStatus } from "../../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { ToggleRow } from "../../ui/ToggleRow";
import { useToast } from "../../ui/toast";
import { shellTypeCopy } from "../../../lib/platform";
import { useSettingSave } from "./useSettingSave";
import { SubSetting } from "./SubSetting";
import { ShellTypeRow } from "./ShellTypeRow";
import { ResetModal } from "./modals";
import { RemoteTlsPanel } from "./RemoteTlsPanel";

/**
 * 「安全」卡（瘦身版）：远程访问相关（HTTPS / 封禁 / 壳层 / 重置）。
 *
 * 2026-10-13（去重统一，方案 A）：路径白名单 / 只读 / 命令执行三个核心开关已搬到
 * 安全页（SecurityOverview）——它们与审计/白名单目录同页才能形成完整的安全视图，
 * 且彻底消除「同一状态两页结论相反」的分叉。本卡保留的全部是远程暴露面设置。
 * 卡顶跳转按钮直达安全页概览（pendingAnchor/highlightAnchor 机制）。
 *
 * 壳层选择留在这里作为命令执行的参数：命令执行开关虽在安全页，壳层是纯本机
 * 配置（cmd/bash），与远程暴露面同卡合理；SubSetting 的禁用态由安全页传不了
 * shellOn，故按 status.shellEnabled 直接判定。
 */
export function SecurityGroup({
  status,
  onSaved,
  onNavigate,
}: {
  status?: StaticStatus;
  onSaved: () => void;
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const { savedKey, save } = useSettingSave(onSaved);
  const [confirmReset, setConfirmReset] = useState(false);
  const [refreshingBash, setRefreshingBash] = useState(false);
  // 壳层相关的平台文案（toast 与 ShellTypeRow 共用同一份，避免两处各写一句逐渐跑偏）
  const shellCopy = shellTypeCopy(status?.platform);
  const { toast } = useToast();

  const shellOn = status?.shellEnabled ?? false;
  // P1 HTTPS 远程访问：开关状态与证书信息同一来源（get_tls_status）。
  // staleTime 30s：本卡内保存后会手动 refetch，不需要跟随 5s 轮询。
  const tlsQuery = useQuery({
    queryKey: ["tls-status"],
    queryFn: () => invoke<TlsStatus>("get_tls_status"),
    staleTime: 30_000,
  });
  const tlsOn = tlsQuery.data?.enabled ?? false;

  const handleRemoteTls = async (next: boolean) => {
    await save({ remoteTlsEnabled: next }, "remote-tls");
    // 监听协议切换必须重启才生效（与 host/port 变更同路径）。
    try {
      await invoke("restart_mcp_server");
      tlsQuery.refetch();
      toast(next ? "HTTPS 已开启，服务已重启" : "已切回 HTTP，服务已重启", "success");
    } catch (e) {
      toast(`重启服务失败：${e}`, "error");
    }
    onSaved();
  };

  const handleResetDefaults = async () => {
    try {
      await invoke<ConfigSaveResult>("save_config", {
        patch: {
          whitelistEnabled: true,
          readonlyMode: false,
          auditEnabled: true,
          backupEnabled: true,
          rateLimitEnabled: true,
          encodingDetectEnabled: false,
          shellEnabled: false,
        },
      });
      setConfirmReset(false);
      onSaved();
    } catch (e) {
      toast(`恢复默认失败：${e}`, "error");
    }
  };

  return (
    <Card id="set-security">
      <CardHeader>
        <CardTitle icon={<Icon name="shield" />}>安全</CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        {/* 三个核心开关的唯一家在安全页；此处给一条直达路（与 HealthCard 胶囊、
            命令面板同一条导航链路：App 的 pendingAnchor → SecurityTab 定位高亮）。 */}
        <Button
          variant="outline"
          size="sm"
          className="mb-4 w-full justify-start gap-2 border-primary/30 bg-primary/8 text-xs font-semibold text-primary hover:bg-primary/12 hover:text-primary"
          onClick={() => onNavigate?.("security", "sec-overview")}
        >
          <Icon name="external" size={14} />
          去安全页管理核心开关
          <span className="font-normal text-muted-foreground">白名单 / 只读 / 命令执行</span>
        </Button>

        <ToggleRow
          id="toggle-remote-tls"
          label="HTTPS 远程访问"
          sub={
            tlsOn
              ? "⚠ 已开启 · 监听端口已切换为 TLS，仅供信任的 AI 工具连接"
              : "开启后 MCP 监听整体切换为 HTTPS，供跨网的 AI 工具连接；关闭时行为与旧版完全一致"
          }
          checked={tlsOn}
          onChange={handleRemoteTls}
          saved={savedKey === "remote-tls"}
        />
        {tlsOn && tlsQuery.data ? (
          <RemoteTlsPanel
            status={status}
            tls={tlsQuery.data}
            onSaved={onSaved}
            onRefetch={() => tlsQuery.refetch()}
          />
        ) : (
          <p className="mb-3 rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            开启后会显示接入地址与封禁设置。跨网暴露请务必保持路径白名单与 Token 保护开启；有
            域名时可优先用反向代理（见 docs/reverse-proxy.md）。
          </p>
        )}

        {/* 壳层是命令执行的参数，命令执行关着时调它不产生任何效果 */}
        <SubSetting disabled={!shellOn} hint="命令执行已关闭，壳层设置暂不生效">
          <ShellTypeRow
            platform={status?.platform}
            value={status?.shellType ?? "cmd"}
            bashAvailable={status?.bashAvailable ?? true}
            onSelect={(v) => save({ shellType: v }, "shelltype")}
            onBashUnavailable={() => toast(shellCopy.unavailableToast, "warning")}
            onRefreshBash={async () => {
              setRefreshingBash(true);
              try {
                const found = await invoke<boolean>("refresh_bash_detection");
                if (found) {
                  toast("已检测到 bash，现在可以切换了", "success");
                } else {
                  toast(shellCopy.stillUnavailableToast, "warning");
                }
              } catch {
                toast("检测失败，请稍后重试", "error");
              } finally {
                setRefreshingBash(false);
                onSaved(); // 触发 get_status 刷新 bashAvailable
              }
            }}
            refreshingBash={refreshingBash}
            saved={savedKey === "shelltype"}
          />
        </SubSetting>
      </CardContent>

      {confirmReset && (
        <ResetModal onCancel={() => setConfirmReset(false)} onConfirm={handleResetDefaults} />
      )}

      {/* 重置覆盖的是安全 + 数据保护 + 高级三张卡的开关（与原行为一致，未改范围），
          放在风险最高的这张卡底部；文案说清范围，不让用户以为只重置安全项。 */}
      <div className="border-t px-5 py-3">
        <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)}>
          <Icon name="refresh" size={13} />
          重置全部功能开关为默认
        </Button>
      </div>
    </Card>
  );
}
