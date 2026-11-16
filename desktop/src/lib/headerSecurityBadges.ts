import type { StaticStatus } from "./types";
import type { SecurityBadge } from "../components/layout/SecurityBadgeGroup";
import { currentConnection, type ConnectionAccess } from "./connectionAccess";

/** Ordinary and full-screen title bars must expose the same risks and destinations. */
export function headerSecurityBadges(status?: StaticStatus, stableConnection = false, access?: ConnectionAccess): SecurityBadge[] {
  const tunnel = (access ?? currentConnection(status))?.method === "stable" || stableConnection;
  // The current-access readout owns connection warnings; these badges retain security risks.
  const hasSummary = !!(access ?? status?.currentAccess);
  return [
    { key: "whitelist", show: !!status && !status.whitelistEnabled, label: "白名单关闭", icon: "alertTriangle", danger: true, tab: "security", anchor: "sec-overview", title: "白名单已关闭，点击前往安全页开启" },
    { key: "ip", show: !hasSummary && !tunnel && !!status?.ipChanged, label: "IP 已变化", icon: "alertTriangle", danger: true, tab: "connect", anchor: "connect-guide", title: "连接地址已变化，点击查看接入配置" },
    { key: "link", show: !hasSummary && !tunnel && !!status?.running && status.remoteReachable === false && !status.ipChanged, label: "本机地址待检查", icon: "alertTriangle", danger: true, tab: "connect", anchor: "connect-guide", title: "本机地址暂不可用，点击查看接入配置" },
    { key: "readonly", show: !!status?.readonlyMode, label: "只读", icon: "lock", danger: false, tab: "security", anchor: "sec-overview", title: "只读模式已开启，点击前往安全页查看" },
    { key: "shell", show: !!status?.shellEnabled, label: "命令执行已开启", icon: "terminal", danger: true, tab: "security", anchor: "sec-overview", title: "命令执行已开启，点击前往安全页关闭" },
  ];
}
