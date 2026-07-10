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
