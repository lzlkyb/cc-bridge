import type { SettingsSection } from "./settingsSections";

export const SETTINGS_CATEGORIES: SettingsSection[] = [
  { id: "set-app", label: "应用", icon: "monitor", group: 0 },
  { id: "set-terminal", label: "终端", icon: "terminal", group: 0 },
  { id: "set-network", label: "网络与接入", icon: "server", group: 1 },
  { id: "set-files", label: "文件与命令", icon: "folder", group: 1 },
  { id: "set-mcpbridge", label: "外挂 MCP", icon: "plug", group: 1 },
  { id: "set-data", label: "数据与记录", icon: "history", group: 2 },
  { id: "set-notify", label: "通知", icon: "bell", group: 2 },
  { id: "set-about", label: "关于与更新", icon: "info", group: 3 },
];

export const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  "set-app": "让界面与日常使用习惯保持一致。",
  "set-terminal": "调整 SSH 终端外观、选择方式与滚动体验。",
  "set-network": "管理服务监听、远程接入与流量保护。",
  "set-files": "控制文件读取、MCP 命令行为与访问边界。",
  "set-mcpbridge": "管理转给远程 AI 的本机 MCP 服务。",
  "set-data": "让备份、记录保留与配置迁移更清楚。",
  "set-notify": "按需要接收命令与任务完成提醒。",
  "set-about": "版本信息、使用帮助与更新记录。",
};

/** Keep old command-palette and workspace links valid after regrouping. */
export const SETTINGS_ANCHOR_CATEGORIES: Record<string, string> = {
  "set-install": "set-app", "set-advanced": "set-files", "set-security": "set-files",
  "set-firewall": "set-network", "set-backupaudit": "set-data", "set-config": "set-data", "set-tokenusage": "set-data",
  "remote-tls": "set-network", ratelimit: "set-network", "network-port": "set-network", "network-transport": "set-network",
  shell: "set-files", shelltype: "set-files", readonly: "set-files", whitelist: "set-files", encoding: "set-files", "session-persist": "set-files",
  backup: "set-data", audit: "set-data", "audit-retention": "set-data", "audit-clean": "set-data",
  "notify-command": "set-notify", "notify-task": "set-notify", "notify-cc": "set-notify",
  "release-webview": "set-app", "app-startup": "set-app", "appearance-title": "set-app", "app-style": "set-app", "app-mode": "set-app",
  "ssh-drag-select": "set-terminal", "ssh-copy-on-select": "set-terminal", "terminal-font": "set-terminal", "terminal-size": "set-terminal",
  "terminal-mode": "set-terminal", "terminal-preset": "set-terminal", "terminal-scrollback": "set-terminal", "terminal-speed": "set-terminal",
  "terminal-scroll-speed": "set-terminal", "terminal-inject": "set-terminal", "terminal-tmux": "set-terminal",
};
