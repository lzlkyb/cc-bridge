/**
 * 多个组件共用的纯函数集中于此（规则 11）。
 */

import type { StaticStatus } from "./types";
// 仅类型导入：utils ⇄ mcpClients 互为引用（mcpClients 用这里的 buildBaseCommand），
// `import type` 在编译后完全擦除，不会产生运行时循环依赖。
import type { McpClientTool } from "./mcpClients";

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

/**
 * 秒数格式化为中文时长（精确到秒），用于运行时长 / 已运行列展示。
 *
 * 超过一天后进一位到“天”：服务跑上几天是常态，“86小时40分12秒”读起来很费劲。
 * 只给最大两级单位（如“3天14小时”而不是“3天14小时22分13秒”）：精度再高对“跑了多久”
 * 这个问题没有意义，而卡片右上角宽度有限。不足一分钟时仍给到秒，刚启动时能看到跳。
 */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
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
  view_image: "查看图片",
  run_command: "执行命令",
  get_command_output: "拉取命令输出",
  wait_command: "等待命令结束",
  stop_command: "终止命令",
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/* ─── Token 用量展示（纯函数，UsageCard 与 TokenUsageGroup 共用，规则 11）─── */

/**
 * token 数格式化：≥1 万显示「x.x万」（保留 1 位小数，去尾随 .0），否则千分位原值。
 * 口径是估算值（见后端 audit.rs），展示层不做任何「账单」暗示。
 */
export function fmtTokens(n: number): string {
  if (n < 10000) return n.toLocaleString("en-US");
  const w = n / 10000;
  return `${w >= 100 ? Math.round(w) : Math.round(w * 10) / 10}万`;
}

/** 日期键 "2026-09-27" → 短标签 "9/27"。非法输入原样返回。 */
export function shortDateKey(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${Number(m[1])}/${Number(m[2])}`;
}

/* ─── 连接页命令拼接（纯函数，ConnectTab 与 TokenManager 共用，规则 11）─── */

/** 展示用主机地址：监听全网卡(0.0.0.0)时取用户选中的 IP，否则用配置的 host。 */
export function buildDisplayHost(status: StaticStatus | undefined, selectedIp: string): string {
  const listenAll = status?.host === "0.0.0.0";
  return listenAll ? selectedIp || "127.0.0.1" : status?.host ?? "";
}

/** 基础接入命令（不含作用域开关），用于拼接到 claude mcp add。 */
export function buildBaseCommand(
  displayHost: string,
  port: number,
  token: string,
  transport: string = "http",
  /** P1 HTTPS 远程访问：true 时端点为 https（与 get_tls_status.enabled 对应）。 */
  tls: boolean = false,
): string {
  const suffix = transport === "sse" ? "/mcp/sse" : "/mcp";
  const scheme = tls ? "https" : "http";
  return `claude mcp add --transport ${transport} cc-bridge ${scheme}://${displayHost}:${port}${suffix} --header "Authorization: Bearer ${token}"`;
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

/** 服务器侧连通性验证命令。TLS 开启时切 https 并加 -k（自签证书，curl 默认拒验）。 */
export function buildHealthCheck(displayHost: string, port: number, tls = false): string {
  return tls
    ? `curl -k https://${displayHost}:${port}/health`
    : `curl http://${displayHost}:${port}/health`;
}

/**
 * 多设备模式（opt-in）的接入/更新命令：条目级 remove+add，幂等可重跑。
 * 条目名 cc-bridge-<deviceId> → 两台机器的条目在远端配置中并存、互不覆盖，
 * 把「互踢」（sed 按 URL 全局替换、后写者赢）变成「并存 + 显式切换」。
 * 固定 user 作用域（project 级跟随目录走，天然按机器隔离）。deviceId 为空返回空串。
 * 🔴 与 Rust `network.rs build_multi_device_command` 逐字一致——双端各生成一份，
 * 改一处必须同步另一处（同 buildIpSedCommand 的既有约定）。
 */
export function buildMultiDeviceCommand(
  displayHost: string,
  port: number,
  token: string,
  transport: string = "http",
  tls = false,
  deviceId = "",
): string {
  if (!deviceId) return "";
  const suffix = transport === "sse" ? "/mcp/sse" : "/mcp";
  const scheme = tls ? "https" : "http";
  const entry = `cc-bridge-${deviceId}`;
  return `claude mcp remove ${entry} 2>/dev/null\nclaude mcp add ${entry} -s user --transport ${transport} --header "Authorization: Bearer ${token}" ${scheme}://${displayHost}:${port}${suffix}`;
}

/**
 * 双引号内的 shell 转义：`\` `"` `` ` `` `$` 前加反斜杠。
 * 项目路径含这些字符时裸拼进 `cd "…"` 会截断字符串或触发命令替换（`$(…)` / 反引号）。
 * 🔴 与 Rust `network.rs escape_double_quoted` 逐字一致（双端各一份，改一处必须同步）。
 */
export function escapeDoubleQuoted(s: string): string {
  // 🔴 双引号内 `\` 只对 `\ " ` $` 与换行有转义意义，所以只在这几种情况下翻倍
  // （外加末尾那个——它会吃掉收尾引号）。一律翻倍会把 `C:\My Project` 变成
  // `C:\\My Project`：语义等价，但用户看到的路径跟资源管理器里复制的不一样。
  // 🔴 与 Rust `network.rs escape_double_quoted` 逐字一致。
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      const next = s[i + 1];
      if (next === undefined || next === "\\" || next === '"' || next === "`" || next === "$") {
        out += "\\";
      }
      out += "\\";
    } else if (c === '"' || c === "`" || c === "$") {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * 可移植的原地编辑：`sed -i.bak EXPR FILE && rm -f FILE.bak`。
 *
 * 为什么不用 `sed -i`：GNU sed 可省略后缀，而 **BSD/macOS 的 `-i` 必须跟备份后缀**，
 * 否则把下一个参数当后缀、报 `invalid command code`——远端是 macOS 时所有 IP / 令牌
 * 修复命令都失效。带 `.bak` 的写法 GNU/BSD/busybox 通吃；成功后顺手删掉备份。
 * 🔴 与 Rust `network.rs sed_in_place` 逐字一致。
 */
export function sedInPlace(expr: string, file: string): string {
  return `sed -i.bak '${expr}' ${file} && rm -f ${file}.bak`;
}

/** 保留家目录简写的含义，其余字符仍按双引号内容转义，禁止路径触发命令替换。 */
export function quoteRemotePath(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME/${escapeDoubleQuoted(path.slice(2))}"`;
  return `"${escapeDoubleQuoted(path)}"`;
}

/**
 * 网络地址变化后「原地更新 IP」的远程 sed 命令（P2 TLS 感知版，IpChangedBanner 消费）。
 * 匹配段用 `https\?://` 同时覆盖 http/https 两种旧值（切换 TLS 协议后也能原地修）；
 * 替换段按当前 TLS 状态生成目标 scheme。不动 Bearer、不 remove+add，幂等可重跑。
 *
 * 多设备模式（opt-in，批3-2）：deviceId 非空且 client 为 codex/workbuddy 时升级为
 * **条目锚定 scoped sed**——地址范围把替换收窄到单个条目块内，远端同文件里其它
 * 设备的条目不再被殃及（互踢根因）。Claude Code 不走这里（它有条目级 CLI，见
 * buildMultiDeviceCommand）；generic 无约定路径仍返回空串。
 * 🔴 与 Rust `network.rs build_scoped_sed_command` 逐字一致（双端各一份，改一处必须同步）。
 */
export function buildIpSedCommand(
  selectedIp: string,
  port: number,
  scope: McpScope,
  projectPath: string,
  tls = false,
  client: McpClientTool = "claude-code",
  /** 多设备身份尾号（4 位 hex）。空 = 单设备，走原全局 sed（兼容性契约）。 */
  deviceId = "",
): string {
  if (!selectedIp) return "";
  // 配置文件按接入工具分流：WorkBuddy / Codex 的 url 也都是文本，同一条 sed 适用（无需重装 client）。
  // generic 没有约定路径 → 返回空串，由调用方改为「请手动更新」提示。
  const cfgFile =
    client === "workbuddy"
      ? "~/.workbuddy/mcp.json"
      : client === "codex"
        ? "~/.codex/config.toml"
        : client === "generic"
          ? ""
          : scope === "user"
            ? "~/.claude.json"
            : ".mcp.json";
  if (!cfgFile) return "";
  // cd 前缀只对 Claude Code 的项目级有意义（其余工具都是全局配置文件）。
  const cdPrefix =
    client === "claude-code" && scope === "project" && projectPath.trim()
      ? `cd ${quoteRemotePath(projectPath.trim())} && `
      : "";
  const target = `${tls ? "https" : "http"}://${selectedIp}:${port}/mcp`;
  const sub = `s#https\\?://[0-9.]*:${port}/mcp#${target}#g`;
  // 多设备 scoped：codex 用 TOML 段头行锚点（规范保证）；workbuddy 用 JSON 条目键 +
  // 「行首 }」收尾。🔴 不能用 `"Authorization"` 收尾（原实现）：条目缺 headers 时
  // 该地址永不命中，范围会一路作用到文件末尾、把其它设备的条目一起改写（互踢）；
  // 裸 `{` 才是字面花括号，`\{` 是 BRE 区间量词开头，会让 sed 直接报 Unmatched \{。
  if (deviceId && (client === "codex" || client === "workbuddy")) {
    const range =
      client === "codex"
        ? `/^\\[mcp_servers\\.cc-bridge-${deviceId}\\]/,/^\\[/`
        : `/"cc-bridge-${deviceId}": {/,/^ *}/`;
    return sedInPlace(`${range} ${sub}`, cfgFile);
  }
  return `${cdPrefix}${sedInPlace(sub, cfgFile)}`;
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
  const cdPrefix =
    scope === "project" && projectPath.trim()
      ? `cd ${quoteRemotePath(projectPath.trim())} && `
      : "";
  return `${cdPrefix}${sedInPlace(`s#Bearer ${oldToken}#Bearer ${token}#g`, cfgFile)}`;
}

/** cc-bridge 除命令执行三元组外的 15 个文件/列表/图片类工具，用于权限授权命令默认不包含命令执行能力。 */
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
  "view_image",
];

/**
 * 生成“一键免重复授权”命令：往 Claude Code 的 permissions.allow 里追加 cc-bridge 工具规则
 * + 信任该 MCP 服务器，免去每次调用都弹窗确认。用 python3 读-改-写，幂等去重，不依赖
 * jq（不保证所有用户环境已安装）。
 * 目标文件固定落 gitignore 的 settings.local.json（项目级）/settings.json（全局），
 * 不是连接命令用的 .mcp.json——权限规则属个人本地免打扰设置，不适合和团队共享的
 * MCP 服务器配置混在一起。
 * includeShellTools=false 时逐个列出 15 个文件/列表/图片类工具规则，run_command 系列不包含；
 * =true 时改成单条 mcp__cc-bridge__* 通配符（等价于全部 22 个，且自动覆盖未来新增工具）。
 */
export function buildPermissionGrantCommand(
  scope: McpScope,
  projectPath: string,
  includeShellTools: boolean,
): string {
  const targetFile = scope === "user" ? "~/.claude/settings.json" : ".claude/settings.local.json";
  const trimmed = projectPath.trim();
  // cd 目标路径加双引号，避免含空格或特殊字符的项目路径拆成多个参数。
  const cdPrefix = scope === "project" && trimmed ? `cd ${quoteRemotePath(trimmed)} && ` : "";

  const toolsBlock = includeShellTools
    ? `if 'mcp__cc-bridge__*' not in allow:\n    allow.append('mcp__cc-bridge__*')`
    : `tools = [${NON_SHELL_TOOLS.map((t) => `'${t}'`).join(", ")}]\nfor t in tools:\n    rule = f'mcp__cc-bridge__{t}'\n    if rule not in allow:\n        allow.append(rule)`;

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
  // 按段取前导整数（parseInt 容忍 "1-rc1" 之类后缀，取到 1）；真正非数字段安全退化为 0。
  // 旧实现用 Number("1-rc1") 得 NaN、再被 || 0 吞成 0，会静默丢掉该段的真实数字。
  const seg = (s: string) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  const pa = a.split(".").map(seg);
  const pb = b.split(".").map(seg);
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

/**
 * 清理 SFTP 报错里的 PTY 噪声：scp/ssh 在 PTY 下会输出 `\r` 进度条、ANSI 转义、
 * 多余空行。剥掉后只留人类可读的错误（权限拒绝 / 路径不存在 / 连接失败等）。
 */
export function cleanErr(raw: unknown): string {
  const s = String(raw ?? "");
  return s
    // eslint-disable-next-line no-control-regex -- 本函数的职责就是剥掉 PTY 的控制字符
    .replace(/\[[0-9;]*m/g, "") // ANSI 颜色
    // eslint-disable-next-line no-control-regex -- 同上：退格是 scp 进度条的刷新方式
    .replace(/[\r]/g, "") // 回车 / 退格（进度条覆盖）
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-6) // 只取末尾关键几行
    .join("\n")
    .trim();
}

/* ─── 白名单排除规则 glob（与 Rust 侧 security/path.rs 同语义，编辑器实时预览用）─── */

/**
 * fnmatch 式 glob：`**` 跨层（零或多段）、`*` 单段内任意字符、`?` 单段内单字符。
 * 与 Rust 实现的对齐约定：
 * - 模式含 `/` → 对相对路径整体匹配；不含 `/` → 对任意一段的段名匹配；
 * - 本应用是 Windows 桌面端，匹配统一不区分大小写；
 * - `\` 与 `/` 都视作路径分隔符。
 * 🔴 预览仅供人工参考，**强制执行在后端 path.rs**——两处语义如需调整必须同步改。
 */
export function globMatch(pattern: string, path: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  const p = norm(pattern);
  const t = norm(path);
  const segMatch = (pat: string[], txt: string[]): boolean => {
    const [ph, ...prest] = pat;
    if (ph === undefined) return txt.length === 0;
    if (ph === "**") {
      for (let n = 0; n <= txt.length; n++) {
        if (segMatch(prest, txt.slice(n))) return true;
      }
      return false;
    }
    const [th, ...trest] = txt;
    if (th === undefined) return false;
    return segFnmatch(ph, th) && segMatch(prest, trest);
  };
  if (p.includes("/")) return segMatch(p.split("/"), t.split("/"));
  return t.split("/").some((seg) => segMatch([p], [seg]));
}

/** 单段内 fnmatch：`*` 任意串、`?` 单字符、其余字面量相等（递归回溯，段很短）。 */
function segFnmatch(pattern: string, text: string): boolean {
  if (pattern.length === 0) return text.length === 0;
  const c = pattern[0];
  const rest = pattern.slice(1);
  if (c === "*") {
    for (let n = 0; n <= text.length; n++) {
      if (segFnmatch(rest, text.slice(n))) return true;
    }
    return false;
  }
  if (text.length === 0) return false;
  if (c === "?") return segFnmatch(rest, text.slice(1));
  return text[0] === c && segFnmatch(rest, text.slice(1));
}
