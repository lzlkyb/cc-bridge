export interface StatusResponse {
  version: string;
  uptimeSeconds: number;
  allowedRoots: string[];
  allowedExtensions: string[];
  maxFileSizeBytes: number;
  rateLimit: { maxRequests: number; windowMs: number };
  backupDir: string;
  backupRetention: number;
  auditRetentionDays: number;
  host: string;
  port: number;
  stats: { totalRequests: number; totalErrors: number };
  connectCommand: string;
  token: string;
  whitelistEnabled: boolean;
  readonlyMode: boolean;
  backupEnabled: boolean;
  auditEnabled: boolean;
  rateLimitEnabled: boolean;
  encodingDetectEnabled: boolean;
  shellEnabled: boolean;
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
  host?: string;
  port?: number;
  whitelistEnabled?: boolean;
  readonlyMode?: boolean;
  backupEnabled?: boolean;
  auditEnabled?: boolean;
  rateLimitEnabled?: boolean;
  encodingDetectEnabled?: boolean;
  shellEnabled?: boolean;
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
