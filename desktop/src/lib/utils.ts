/**
 * 多个组件共用的纯函数集中于此（规则 11）。
 */

import type { StatusResponse } from "./types";

/** 接入作用域：用户级（~/.claude.json）或项目级（.mcp.json）。 */
export type McpScope = "user" | "project";

/** H6 修复：统一剪贴板复制入口。navigator.clipboard.writeText 未 await/catch 时，权限被拒绝会出现
 * "显示已复制但其实没复制"的假阳性反馈（ConnectTab/TokenManager/onboarding 多处同款问题）。
 * 调用方传 onSuccess/onError 回调，不内置 toast 依赖（不同调用点的成功/失败文案不一致）。 */
export async function copyText(
  text: string,
  onSuccess: () => void,
  onError?: (e: unknown) => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onSuccess();
  } catch (e) {
    onError?.(e);
  }
}

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

/**
 * 毫秒耗时格式化为一眼可读的中文文本，自动换算单位（微秒/毫秒/秒/分），避免用户看到
 * 大数字（如 10000ms）还要心算，也不用英文缩写（ms/s）而用中文单位。
 * - <1ms：换算成微秒（审计写盘等微秒级耗时仍能看清，不四舍五入成 0）。
 * - <10ms：毫秒保留 1 位小数（区分 1.2毫秒与 8.7毫秒）。
 * - <1000ms：毫秒取整。
 * - <60s：换算成秒（保留 1 位小数，如 10000ms → "10.0秒"）。
 * - ≥60s：换算成 "X分Y秒"。
 */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) return "0毫秒";
  if (ms < 1) return `${Math.round(ms * 1000)}微秒`;
  if (ms < 10) return `${ms.toFixed(1)}毫秒`;
  if (ms < 1000) return `${Math.round(ms)}毫秒`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}秒`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}分${s}秒`;
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
export function buildBaseCommand(displayHost: string, port: number, token: string, transport: string = "http"): string {
  const urlSuffix = transport === "sse" ? "/mcp/sse" : "/mcp";
  return `claude mcp add --transport ${transport} cc-bridge http://${displayHost}:${port}${urlSuffix} --header "Authorization: Bearer ${token}"`;
}

/**
 * 按作用域补全 --scope 参数。
 * 修复（2026-07-13）：之前项目级分支不加任何 --scope，而 Claude Code CLI 不带 --scope 时默认是
 * local scope（写入 ~/.claude.json 按项目路径存的部分），而非 UI 文案对用户宣称的 .mcp.json。
 * 导致 IpChangedBanner/TokenManager 生成的 sed 命令（假设 project scope = .mcp.json）
 * 在项目级场景下实际改不到真正生效的配置文件。现显式加 --scope project，与
 * buildTokenSedCommand / IpChangedBanner 里 "project => .mcp.json" 的假设保持一致。
 */
export function buildConnectCommand(baseCommand: string, scope: McpScope): string {
  return scope === "user"
    ? baseCommand.replace("claude mcp add", "claude mcp add --scope user")
    : baseCommand.replace("claude mcp add", "claude mcp add --scope project");
}

/** 服务器侧连通性验证命令。 */
export function buildHealthCheck(displayHost: string, port: number): string {
  return `curl http://${displayHost}:${port}/health`;
}

/** 网络地址友好提示：帮助用户判断远程服务器该选哪个 IP 连回本机。ConnectTab 与引导向导共用。 */
export function ipHint(ip: string): string {
  if (ip.startsWith("192.168.")) return "家用/办公内网";
  if (ip.startsWith("10.")) return "VPN 或企业内网";
  if (ip.startsWith("172.")) return "内网 / 容器网段";
  return "其它网段";
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

/** cc-bridge 除命令执行三元组外的 14 个文件/列表类工具，用于权限授权命令默认不包含命令执行能力。 */
const NON_SHELL_TOOLS = [
  "list_allowed_roots",
  "list_directory",
  "read_files",
  "write_files",
  "edit_files",
  "create_directory",
  "remove_directory",
  "delete_files",
  "move_files",
  "copy_files",
  "search_files",
  "batch",
  "notebook_edit",
  "analyze_file",
];

/**
 * 生成“一键免重复授权”命令：往 Claude Code 的 permissions.allow 里追加 cc-bridge 工具规则
 * + 信任该 MCP 服务器，免去每次调用都弹窗确认。用 python3 读-改-写，幂等去重，不依赖
 * jq（不保证所有用户环境已安装）。
 * 目标文件固定落 gitignore 的 settings.local.json（项目级）/settings.json（全局），
 * 不是连接命令用的 .mcp.json——权限规则属个人本地免打扰设置，不适合和团队共享的
 * MCP 服务器配置混在一起。
 * includeShellTools=false 时逐个列出 14 个文件/列表类工具规则，run_command 系列不包含；
 * =true 时改成单条 mcp__cc-bridge__* 通配符（等价于全部 17 个，且自动覆盖未来新增工具）。
 */
export function buildPermissionGrantCommand(
  scope: McpScope,
  projectPath: string,
  includeShellTools: boolean,
): string {
  const targetFile = scope === "user" ? "~/.claude/settings.json" : ".claude/settings.local.json";
  const trimmed = projectPath.trim();
  const cdPrefix = scope === "project" && trimmed ? `cd ${trimmed} && ` : "";

  const toolsBlock = includeShellTools
    ? `if 'mcp__cc-bridge__*' not in allow:\n    allow.append('mcp__cc-bridge__*')`
    : `tools = ${JSON.stringify(NON_SHELL_TOOLS)}\nfor t in tools:\n    rule = f'mcp__cc-bridge__{t}'\n    if rule not in allow:\n        allow.append(rule)`;

  return `${cdPrefix}python3 -c "
import json, os
p = os.path.expanduser('${targetFile}')
d = json.load(open(p)) if os.path.exists(p) else {}
allow = d.setdefault('permissions', {}).setdefault('allow', [])
${toolsBlock}
d['enableAllProjectMcpServers'] = True
servers = d.setdefault('enabledMcpjsonServers', [])
if 'cc-bridge' not in servers:
    servers.append('cc-bridge')
os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
print('已写入:', os.path.abspath(p))
"`;
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

/**
 * 绝对时间（备份 createdAt 形如 "YYYY-MM-DD HH:MM:SS"）转中文相对时间：
 * 刚刚 / X 分钟前 / X 小时前 / X 天前 / X 个月前 / X 年前。
 * 解析失败（如"未知时间"）原样返回，避免崩溃。
 */
export function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return "";
  const s = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T");
  const d = new Date(s);
  if (isNaN(d.getTime())) return dateStr;
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 0) return dateStr; // 未来时间（时钟异常）回退原值
  if (diffSec < 60) return "刚刚";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon} 个月前`;
  return `${Math.floor(mon / 12)} 年前`;
}

/** 字节数格式化为带单位的人类可读文本（B/KB/MB/GB），SecurityTab 与版本历史弹框共用（规则 11）。 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

/** 下载速率格式化（复用 formatBytes 加 "/s" 后缀），UpdateBadge/AboutGroup 的更新进度展示共用。 */
export function formatBytesPerSec(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}
