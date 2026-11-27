export type StorageGroup = "backup" | "logs" | "update" | "temp" | "data";
export type CleanupKind = "audit" | "journal" | "relay" | "update" | "temp";

export interface StoragePolicy {
  autoClean: boolean;
  dailyTime: string;
  diskAlert: boolean;
  minFreeGb: number;
  backupAlert: boolean;
  backupLimitGb: number;
}

export interface StorageUsage {
  group: StorageGroup;
  usedBytes: number;
  eligibleBytes: number;
}

export interface CleanupRun {
  at: string;
  source: "manual" | "scheduled";
  freedBytes: number;
  removedCount: number;
  skipped: { kind: CleanupKind; count: number; reason: string }[];
  recorded: boolean;
}

export interface StorageOverview {
  groups: StorageUsage[];
  volume: { label: string; freeBytes: number; totalBytes: number } | null;
  policy: StoragePolicy;
  history: CleanupRun[];
  warnings: string[];
  scannedAt: string;
}

export interface CleanupItem {
  kind: CleanupKind;
  bytes: number;
  count: number;
  retentionDays: number | null;
}

export interface StoragePreview {
  token: string;
  items: CleanupItem[];
  warnings: string[];
}

export const GIB = 1024 ** 3;

export const storageGroups = {
  backup: { label: "文件备份", description: "可用于恢复文件的历史版本" },
  logs: { label: "日志", description: "审计、变更和模型中转记录" },
  update: { label: "更新缓存", description: "已下载的安装包和续传文件" },
  temp: { label: "临时文件", description: "应用中转文件及 SSH 编辑副本" },
  data: { label: "应用数据", description: "连接配置、界面数据与历史记录" },
} satisfies Record<StorageGroup, { label: string; description: string }>;

export const cleanupKinds = {
  audit: { label: "过期审计日志", group: "logs" },
  journal: { label: "过期变更日志", group: "logs" },
  relay: { label: "过期中转日志", group: "logs" },
  update: { label: "失效的更新缓存", group: "update" },
  temp: { label: "失效的临时文件", group: "temp" },
} satisfies Record<CleanupKind, { label: string; group: StorageGroup }>;

export function maintenanceTitle(run: CleanupRun) {
  if (run.skipped.length) return run.removedCount ? "清理部分完成" : "本次未能清理";
  return run.removedCount ? "清理完成" : "没有需要清理的项目";
}

export function storageTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}
