import type { StaticStatus } from "../lib/types";
import type { CommandItem } from "../components/modals/CommandPaletteList";
import { useCurrentConnection } from "./useCurrentConnection";
import { useConnectionCopy } from "./useConnectionCopy";
import { useServiceControl } from "./useServiceControl";
import { toast } from "../components/ui/toast";
import { CONNECT_GUIDE_ANCHOR } from "../lib/connectionAccess";

/** The palette exposes only actions valid for the selected method and saved target. */
export function useConnectionPaletteItems(status?: StaticStatus, onChanged?: () => void): CommandItem[] {
  const access = useCurrentConnection(status);
  const copy = useConnectionCopy(status);
  const service = useServiceControl(status, onChanged);
  const running = !!status?.running;
  const items: CommandItem[] = [
    { id: "act-server", label: service.busy ? "本机服务处理中…" : running ? "停止本机服务" : "启动本机服务", icon: running ? "pause" : "play", group: "操作", disabled: service.busy || !status,
      run: async () => { if (await service.run(running ? "stop" : "start")) toast(running ? "本机服务已停止，全部接入受影响" : "本机服务已启动", "success"); } },
    { id: "act-restart", label: "重启本机服务", icon: "refresh", group: "操作", disabled: service.busy || !running,
      run: async () => { if (await service.run("restart")) toast("本机服务已重启", "success"); } },
    { id: "act-access-check", label: "查看与检查当前接入", icon: "plug", group: "当前接入", tab: "connect", anchor: CONNECT_GUIDE_ANCHOR, keywords: "隧道 稳定 检查 连接 Claude 项目 MCP" },
  ];
  if (!access) return items;
  if (access.canCopyAddress) items.push({ id: "act-access-address", label: access.method === "stable" ? "复制服务器固定接入地址" : "复制直连接入地址", icon: "copy", group: "当前接入", run: () => copy.copy("address", "接入地址已复制") });
  items.push(access.canCopyCommand
    ? { id: "act-access-command", label: "复制当前连接命令", icon: "copy", group: "当前接入", run: () => copy.copy("command", "连接命令已复制，请在服务器执行后验证") }
    : { id: "act-access-command", label: access.configured ? "检查并应用原接入配置" : "一键接入隧道连接", icon: "plug", group: "当前接入", tab: "connect", anchor: CONNECT_GUIDE_ANCHOR });
  if (access.canUpdateIp) items.push({ id: "act-ipsed", label: "复制 IP 替换命令", icon: "copy", group: "当前接入", run: () => copy.copy("ip-update", "地址更新命令已复制，请在服务器执行后验证"), keywords: "ip 地址 替换 sed 修复 重连 中断" });
  if (access.method === "direct" && access.tokenUpdatePending) items.push({ id: "act-token-update", label: "复制原接入 Token 更新命令", icon: "key", group: "当前接入", run: () => copy.copy("token-update", "Token 更新命令已复制，请在原接入位置执行") });
  return items;
}
