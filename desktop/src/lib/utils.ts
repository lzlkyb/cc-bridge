/**
 * 多个组件共用的纯函数集中于此（规则 11）。
 */

import type { StatusResponse } from "./types";

/** 接入作用域：用户级（~/.claude.json）或项目级（.mcp.json）。 */
export type McpScope = "user" | "project";

/** 秒数格式化为 "Xh Ym Zs" / "Ym Zs" / "Zs"，用于运行时长展示（精确到秒）。 */
export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** 版本号统一格式化为 "vX.Y.Z"（已带 v 则不重复加）。各处版本展示共用，避免前缀漂移。 */
export function formatVersion(v?: string): string {
  if (!v) return "?";
  return v.startsWith("v") ? v : `v${v}`;
}

/** MCP 工具名 → 中文操作名，用于审计日志友好展示。未知工具回退原名。 */
const TOOL_LABELS: Record<string, string> = {
  list_allowed_roots: "列出白名单",
  list_directory: "列目录",
  read_files: "读取文件",
  write_files: "写入文件",
  edit_files: "编辑文件",
  delete_files: "删除文件",
  move_files: "移动/重命名",
  copy_files: "复制文件",
  create_directory: "创建目录",
  remove_directory: "删除目录",
  search_files: "搜索文件",
  analyze_file: "分析文件",
  run_command: "执行命令",
  get_command_output: "拉取命令输出",
  stop_command: "终止命令",
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/* ─── 连接页命令拼接（纯函数，ConnectTab 与 TokenManager 共用，规则 11）─── */

/** 展示用主机地址：监听全网卡(0.0.0.0)时取用户选中的 IP，否则用配置的 host。 */
export function buildDisplayHost(status: StatusResponse | undefined, selectedIp: string): string {
  const listenAll = status?.host === "0.0.0.0";
  return listenAll ? selectedIp || "127.0.0.1" : status?.host ?? "";
}

/** 基础接入命令（不含作用域开关），用于拼接到 claude mcp add。 */
export function buildBaseCommand(displayHost: string, port: number, token: string): string {
  return `claude mcp add --transport http cc-bridge http://${displayHost}:${port}/mcp --header "Authorization: Bearer ${token}"`;
}

/** 按作用域补全 --scope user（项目级不加）。 */
export function buildConnectCommand(baseCommand: string, scope: McpScope): string {
  return scope === "user"
    ? baseCommand.replace("claude mcp add", "claude mcp add --scope user")
    : baseCommand;
}

/** 服务器侧连通性验证命令。 */
export function buildHealthCheck(displayHost: string, port: number): string {
  return `curl http://${displayHost}:${port}/health`;
}

/** Token 重生成后原地替换 Bearer 的 sed 命令（不 remove+add，保留授权状态）。 */
export function buildTokenSedCommand(
  oldToken: string,
  token: string,
  scope: McpScope,
  projectPath: string,
): string {
  if (!oldToken || !token) return "";
  const cfgFile = scope === "user" ? "~/.claude.json" : ".mcp.json";
  const cdPrefix = scope === "project" && projectPath.trim() ? `cd ${projectPath.trim()} && ` : "";
  return `${cdPrefix}sed -i 's#Bearer ${oldToken}#Bearer ${token}#g' ${cfgFile}`;
}

/* ─── 更新历史「已读」状态（localStorage，纯函数，规则 11）─── */

const CHANGELOG_LAST_SEEN_KEY = "ccb_changelog_last_seen";

/** 读取用户上次看到的版本（未看过返回 null）。 */
export function getLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(CHANGELOG_LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

/** 记录用户已看到某版本（通常是当前最新版）。 */
export function setLastSeenVersion(version: string): void {
  try {
    localStorage.setItem(CHANGELOG_LAST_SEEN_KEY, version);
  } catch {
    /* localStorage 不可用时静默忽略，仅影响红点提示 */
  }
}

/** 语义版本比较：a>b 返回正数，a<b 返回负数，相等 0。 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** 统计比 lastSeen 更新的版本数量（用于「更新」Tab 未读红点）。 */
export function countUnreadVersions(versions: string[], lastSeen: string | null): number {
  if (!lastSeen) return versions.length; // 从未看过 → 全部未读
  return versions.filter((v) => compareVersion(v, lastSeen) > 0).length;
}
