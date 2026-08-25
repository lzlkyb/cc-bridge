export interface StatusResponse {
  version: string;
  uptimeSeconds: number;
  allowedRoots: string[];
  allowedExtensions: string[];
  maxFileSizeBytes: number;
  rateLimit: { maxRequests: number; windowMs: number };
  backupDir: string;
  /** 备份目录绝对路径（data_dir / backup_dir），设置页直接展示，无需前端拼凑。 */
  backupDirAbs: string;
  /** 备份目录内 .bak 文件总数（get_status 扫描得到）。 */
  backupCount: number;
  /** 备份目录总占用字节数。 */
  backupTotalBytes: number;
  backupRetention: number;
  auditRetentionDays: number;
  /** 后台命令结束后保留时长（秒），默认 120。 */
  commandCleanupSecs: number;
  host: string;
  port: number;
  stats: {
    totalRequests: number;
    totalErrors: number;
    /** 实时成功率（%），累计 = (total-errors)/total*100 */
    successRate: number;
    /** 请求速率：近 60s 窗口内请求数 */
    requestsPerMin: number;
    /** 平均耗时（ms） */
    avgLatencyMs: number;
    /** P95 耗时（ms） */
    p95LatencyMs: number;
    /** 限流命中次数（429） */
    rateLimitHits: number;
    /** 鉴权拒绝次数（401） */
    authDenies: number;
    /** 审计落盘条数 */
    auditCount: number;
    /** 当前活跃后台命令数 */
    activeCommands: number;
    /** 热门工具 Top3 */
    topTools: { name: string; count: number }[];
  };
  connectCommand: string;
  token: string;
  whitelistEnabled: boolean;
  readonlyMode: boolean;
  backupEnabled: boolean;
  auditEnabled: boolean;
  rateLimitEnabled: boolean;
  encodingDetectEnabled: boolean;
  shellEnabled: boolean;
  /** 命令会话持久化（run_command 的 session_id 跨调用保留 cwd + env）。默认关闭 */
  sessionCwdEnabled: boolean;
  /** 命令执行壳层：cmd（默认）或 bash（Git Bash） */
  shellType: string;
  /** MCP 传输协议：http（默认，JSON-RPC）或 sse（流式输出） */
  transport: string;
  /** 本机是否检测到 Git for Windows 的 bash.exe。false 时前端「命令执行壳层」的 bash 选项置灰且点击提示，不保存。 */
  bashAvailable: boolean;
  running: boolean;
  lanIps: string[];
  lastSelectedIp: string | null;
  ipChanged: boolean;
  /** S1：远程链路可达性探针。对远程客户端应连接的展示地址:port 做 TCP 探测。
   *  false 表示「服务在跑但远程连不回」（地址失效/网络断开），驱动「远程连接中断」状态。 */
  remoteReachable: boolean;
  scope: string | null;
  /** 用户接入时确认的项目路径（project 作用域时生效）。由连接页保存，前端据此回填避免每次进入被重置为 null。 */
  projectPath: string | null;
  /** A3 修复：启动期错误（如端口被占用）。null = 正常 */
  startupError: string | null;
  /** 防火墙状态（仅 Windows 真实查询，其它平台为 null）。
   *  firewallEnabled：防火墙是否开启；firewallPortOpen：7823/TCP 入站是否放行。
   *  null 表示无法判断（非 Windows / 查询失败）。 */
  firewallEnabled: boolean | null;
  firewallPortOpen: boolean | null;
  /** 防火墙探测是否可用。false = 后端启动探测发现 netsh 异常，此后停用查询以避免反复弹系统错误框。
   *  由后端启动时写入（state.firewall_available，默认 true）。undefined/null = 未确定，按可用处理。 */
  firewallAvailable?: boolean | null;
  /**
   * 白名单配置组（存档）与当前组名，用于「按项目切换白名单」。
   * **不参与安全判定**——当前生效的集合永远是上面的 `allowedRoots`，
   * 组只是存档（后端同一取舍，见 config.rs 的 RootProfile）。
   */
  rootProfiles: RootProfile[];
  activeProfile: string;
  /** Layer 2 命令白名单开关（opt-in，④P0-1）。默认关闭。开启后 run_command 子命令首 token 须在白名单内。 */
  commandAllowlistEnabled: boolean;
  /** Layer 2 命令白名单程序列表（大小写不敏感 basename 匹配）。 */
  commandAllowlist: string[];
  /** 后台命令完成通知开关。默认开启——后台命令结束后自动推系统桌面通知
   *  （Windows toast / macOS 通知中心；文案见 lib/platform.ts 的 notifyCommandCompleteSub）。 */
  notifyCommandComplete: boolean;
  /** 任务完成通知开关（push_notification MCP 工具总开关）。默认开启。 */
  notifyTaskComplete: boolean;
  /**
   * 关窗时释放界面内存。默认开启。
   * 开：关窗销毁窗口与 webview，再开需重新加载（1~2 秒）；
   * 关：仅隐藏，秒开但内存持续占用。两者都不影响 MCP 服务 / 托盘 / 桌面通知。
   * 具体能省多少内存两个平台差很多、且测量口径不同，数字只在
   * lib/platform.ts 的 releaseWebviewHint() 里维护一份，别在别处再写一遍。
   */
  releaseWebviewOnClose: boolean;
  /**
   * 终端拖拽即选：在 xterm 内拖拽即自动进选择态复制。默认关闭。
   */
  sshDragSelectEnabled: boolean;
  /**
   * 运行平台：`"windows"` / `"macos"` / `"linux"`（后端 `std::env::consts::OS`）。
   * 用于隐藏 Windows 专属 UI 与切换快捷键标签，见 `lib/platform.ts`。
   */
  platform: string;
}

/* ─── 状态分层：高频字段 vs 稳定字段 ─── */

/**
 * 每次轮询必变的字段。实查全工程，**只有 ConnectHero 读这两个**。
 */
export type LiveStatus = Pick<StatusResponse, "uptimeSeconds" | "stats">;

/**
 * 剔掉高频字段后的状态，供不关心实时数字的组件使用。
 *
 * 为何要分这一层：`uptimeSeconds` / `stats` 每 5s 轮询都变 → `StatusResponse` 顶层引用
 * 必然是新的 → 包了 `memo` 的 Header / ConnectTab 也弹不住，当前 Tab 整棵每 5s 重渲染。
 * 把这两个字段剔掉后，react-query 的 structural sharing 会在其余字段未变时**保持旧引用**，
 * memo 才真正生效（参见「功能优化清单.md」M14）。
 */
export type StaticStatus = Omit<StatusResponse, "uptimeSeconds" | "stats">;

/** 一个白名单配置组（按项目切换用）。与后端 `config.rs` 的 `RootProfile` 一一对应。 */
export interface RootProfile {
  name: string;
  roots: string[];
}

/* ─── 防火墙结构化诊断（get_firewall_diagnosis）─── */

/** 诊断问题项。code 与后端 firewall_diag.rs 的问题码表一致。 */
export interface FirewallIssue {
  code:
    | "firewallOff"
    | "noRule"
    | "profileGap"
    | "blockRule"
    | "staleRule"
    | "duplicateRule"
    | "localPolicyBlocked"
    | "probeUnavailable"
    | string;
  /** 面向用户的具体描述（已含涉事配置文件名 / 规则名）。 */
  detail: string;
  /** 能否被「一键修复」解决。false 的项需用户或 IT 介入。 */
  fixable: boolean;
}

export interface FirewallRuleInfo {
  name: string;
  /** `Allow` | `Block`。 */
  action: string;
  /** 规则覆盖的配置文件，如 `Any` / `Public` / `Domain, Private`。 */
  profiles: string;
  /** 规则绑定的程序路径；null = 不限程序。 */
  program: string | null;
  localPort: string;
  enabled: boolean;
}

export interface FirewallProfileInfo {
  /** `Domain` | `Private` | `Public`。 */
  name: string;
  enabled: boolean;
  defaultInboundBlock: boolean;
  /** false = 域策略禁止本地规则生效，本机加规则无效。 */
  allowLocalRules: boolean;
  /** 当前网络是否落在此配置文件——规则只在活动配置文件下生效。 */
  active: boolean;
  /** 该配置文件下本端口入站是否真的通。 */
  covered: boolean;
}

export interface FirewallDiagnosis {
  port: number;
  /** 当前可执行文件路径（规则 program= 的比对基准）。 */
  exe: string;
  enabled: boolean | null;
  portOpen: boolean | null;
  profiles: FirewallProfileInfo[];
  activeProfiles: string[];
  allowRules: FirewallRuleInfo[];
  blockRules: FirewallRuleInfo[];
  staleRules: FirewallRuleInfo[];
  issues: FirewallIssue[];
  /** netsh 回退路径拿不到配置文件覆盖/阻止规则信息，前端据此提示诊断能力受限。 */
  source: "powershell" | "netsh" | "unavailable" | string;
}

export interface FirewallDiagnosisResponse {
  /** null = 尚未完成首次检查。 */
  diagnosis: FirewallDiagnosis | null;
  available: boolean;
  manualCommand: string;
  ruleName: string;
  checkedSecondsAgo: number | null;
}

export interface ConfigPatch {
  allowedRoots?: string[];
  allowedExtensions?: string[];
  maxFileSizeBytes?: number;
  rateLimitMaxRequests?: number;
  rateLimitWindowMs?: number;
  backupDir?: string;
  backupRetention?: number;
  auditRetentionDays?: number;
  commandCleanupSecs?: number;
  host?: string;
  port?: number;
  whitelistEnabled?: boolean;
  readonlyMode?: boolean;
  backupEnabled?: boolean;
  auditEnabled?: boolean;
  rateLimitEnabled?: boolean;
  encodingDetectEnabled?: boolean;
  shellEnabled?: boolean;
  /** 命令执行壳层：cmd 或 bash。前端「命令执行壳层」分段控件写入。 */
  shellType?: string;
  /** MCP 传输协议：http 或 sse。前端「MCP 传输协议」分段控件写入。 */
  transport?: string;
  scope?: string;
  /** 用户接入时确认的项目路径（项目级 scope 时用于 cd 前缀）。跟随连接页选择，供托盘生成精确 sed 命令。 */
  projectPath?: string;
  /** Layer 2 命令白名单开关（④P0-1）。前端「安全」页写入。 */
  commandAllowlistEnabled?: boolean;
  /** Layer 2 命令白名单程序列表（④P0-1）。前端「安全」页写入。 */
  commandAllowlist?: string[];
  /** 后台命令完成通知开关。前端「功能开关」卡写入。 */
  notifyCommandComplete?: boolean;
  /** 任务完成通知开关。前端「功能开关」卡写入。 */
  notifyTaskComplete?: boolean;
  /** 关窗时释放界面内存。前端「兼容与性能」分组写入。 */
  releaseWebviewOnClose?: boolean;
  /** 终端拖拽即选开关。前端「高级」分组写入。 */
  sshDragSelectEnabled?: boolean;
}

export interface ConfigSaveResult {
  ok: boolean;
  changed: string[];
  warnings: string[];
  restartRequired: boolean;
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  params: string;
  success: boolean;
  error?: string;
  sourceIp?: string;
  durationMs?: number;
  // ── O1 结构化耗时拆解（落地后由后端写入，前端向前兼容读取）──
  serverMs?: number; // 服务端总墙钟（请求收到→响应发出）
  ioMs?: number; // 实际文件读写 / 备份耗时
  auditMs?: number; // 审计写盘耗时
  netMs?: number; // 网络往返估算（O1-b 探针，可选）
  overheadMs?: number; // 请求解析 + 响应序列化 + 线缆传输
  /** 关联备份：本操作前生成的 .bak 绝对路径（写/删类操作且备份开启时存在），供一键回滚 / Diff。 */
  backupPath?: string;
  /** 关联备份：被备份/覆盖的目标文件绝对路径，供回滚写回定位。 */
  targetPath?: string;
}

/** get_file_diff 返回的单行 diff（行级红绿高亮）。 */
export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

/** get_file_diff 返回的变更 Diff 结果。guard 非空表示触发护栏（仅可还原、不预览全量 diff）。 */
export interface FileDiffResult {
  lines: DiffLine[];
  guard: string | null;
  beforeLines: number;
  afterLines: number;
}

/** list_backups 返回的单个备份条目。 */
export interface BackupFileInfo {
  backupPath: string;
  sizeBytes: number;
  /** 已格式化为 "YYYY-MM-DD HH:MM:SS" */
  createdAt: string;
  /** 创建备份时记录的原始绝对路径（仍落在白名单内才返回）；白名单关闭或无索引记录（历史备份）时为空。 */
  targets: string[];
}

/** list_backups 返回的按原文件名分组结果。 */
export interface BackupGroupInfo {
  originalFile: string;
  count: number;
  totalBytes: number;
  entries: BackupFileInfo[];
}

/** list_backups 返回的完整结果。 */
export interface BackupListResult {
  dir: string;
  exists: boolean;
  count: number;
  totalBytes: number;
  groups: BackupGroupInfo[];
}

/** preview_backup_cleanup 返回：给条件算出的清理计划统计（无副作用）。 */
export interface BackupCleanupPreview {
  /** 待删份数 */
  count: number;
  freedBytes: number;
  totalBytesBefore: number;
  totalCountBefore: number;
  /** 执行后将不再有任何备份的原文件（预览里那行红字要列出来） */
  filesLosingAll: string[];
  /**
   * 待删备份的完整路径清单，确认时**原样回传**给 `cleanup_backups`。
   * 这是「预览 == 执行」的实现方式：后端只删这份清单，不重新按条件算。
   */
  victims: string[];
}

/** cleanup_backups / delete_backups_of_file 返回：实际执行结果。 */
export interface BackupCleanupResult {
  removed: number;
  freedBytes: number;
  /** 顺手清掉的孤儿索引行数（历史上绕过面板手删备份遗留的） */
  healedIndexRows: number;
  /** 删失败的份数（被占用 / 只读属性等），大于 0 时必须告知用户 */
  failed: number;
}

export interface RunningCommandInfo {
  handle: string;
  pid: number;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  elapsedSeconds: number;
}

/** get_audit_log 返回的审计日志分页结果（策略 A：页码分页）。 */
export interface AuditPage {
  entries: AuditEntry[];
  /** 审计日志总条数（用于前端算总页数，不受当前页大小影响） */
  total: number;
  /** 当前页（≥1） */
  page: number;
  /** 每页条数 */
  pageSize: number;
}

/** get_command_output 返回的后台命令实时输出（stdout/stderr 为本次增量片段）。 */
export interface CommandOutput {
  stdout: string;
  stderr: string;
  stdoutTotalBytes: number;
  stderrTotalBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  running: boolean;
  exitCode: number | null;
  pid: number;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

/* ─── SSH 终端（面板内交互终端，首版密码登录）─── */

/** 一条 SSH 连接配置（与后端 `config.rs::SshConnection` 对应，camelCase）。 */
export interface SshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** 认证方式：password（密码）/ key（私钥 + 可选密码短语）。 */
  authType: string;
  rememberPassword: boolean;
  /** aes-gcm 密文（base64），仅 rememberPassword 时非空；前端拿不到明文。 */
  encryptedPassword: string;
  /** 私钥路径（authType==="key" 时有效）。 */
  keyPath: string;
  /** 是否记住密钥密码短语（仅 key 认证有意义）。 */
  rememberPassphrase: boolean;
  /** aes-gcm 密文（base64），仅 rememberPassphrase 时非空；前端拿不到明文。 */
  encryptedPassphrase: string;
}

/** `ssh_check` 返回：系统 ssh 是否可用 + 路径 + 不可用时的安装指引。 */
export interface SshCheckResult {
  available: boolean;
  path: string | null;
  installHint: string | null;
}

/** `ssh_list_connections` 返回：开关 + 连接列表。 */
export interface SshConnectionList {
  enabled: boolean;
  connections: SshConnection[];
}

/** `ssh_output` 事件载荷：一段终端输出增量。 */
export interface SshOutput {
  sessionId: string;
  data: string;
}

/** `ssh_closed` 事件载荷：ssh 进程退出。 */
export interface SshClosed {
  sessionId: string;
}

/** `ssh_connect_failed` 事件载荷：连接早期失败（进程在宽限期内自行退出）。 */
export interface SshConnectFailed {
  sessionId: string;
  /** 可读失败原因（中文）。 */
  reason: string;
}

/** `ssh_sftp_list` 返回：单个远程文件/目录条目。 */
export interface SshFileEntry {
  /** 文件名（含软链 ` -> target` 后缀）。 */
  name: string;
  /** 是否为目录。 */
  isDir: boolean;
  /** 字节大小（目录为 0）。 */
  size: number;
  /** 修改时间（Unix 秒）。 */
  mtime: number;
  /** 是否为软链接。 */
  isSymlink: boolean;
}
