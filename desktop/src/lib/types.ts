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
