import type { StaticStatus } from "./types";
import type { SecurityBadge } from "../components/layout/SecurityBadgeGroup";

/** Ordinary and full-screen title bars must expose the same risks and destinations. */
export function headerSecurityBadges(status?: StaticStatus): SecurityBadge[] {
  return [
    { key: "whitelist", show: !!status && !status.whitelistEnabled, label: "白名单关闭", icon: "alertTriangle", danger: true, tab: "security", anchor: "sec-overview", title: "白名单已关闭，点击前往安全页开启" },
    { key: "ip", show: !!status?.ipChanged, label: "IP 已变化", icon: "alertTriangle", danger: true, tab: "connect", title: "连接地址已变化，点击前往连接页查看" },
    { key: "link", show: !!status?.running && status.remoteReachable === false && !status.ipChanged, label: "远程不可达", icon: "alertTriangle", danger: true, tab: "connect", title: "远程连接不可达，点击前往连接页查看" },
    { key: "readonly", show: !!status?.readonlyMode, label: "只读", icon: "lock", danger: false, tab: "security", anchor: "sec-overview", title: "只读模式已开启，点击前往安全页查看" },
    { key: "shell", show: !!status?.shellEnabled, label: "命令执行已开启", icon: "terminal", danger: true, tab: "security", anchor: "sec-overview", title: "命令执行已开启，点击前往安全页关闭" },
  ];
}
