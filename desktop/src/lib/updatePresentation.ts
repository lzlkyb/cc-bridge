export interface UpdateActivity {
  conversations: number;
  agents: number;
  commands: number;
  transfers: number;
  terminals?: number;
  relayRequests?: number;
}

export type RestartSafety =
  | { state: "checking" }
  | { state: "unknown" }
  | { state: "known"; activity: UpdateActivity };

export interface UpdatePresentation {
  status: "available" | "downloading" | "verifying" | "staged" | "installing" | "ready" | "error" | "checking";
  progress: number;
  indeterminate: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  bytesPerSec: number;
  error?: string | null;
  restarting?: boolean;
  safety: RestartSafety;
}

export function activitySummary(activity: UpdateActivity): string {
  return ([
    [activity.conversations, "个对话"], [activity.agents, "个后台成员"],
    [activity.commands, "个后台命令"], [activity.transfers, "个文件传输"],
    [activity.terminals ?? 0, "个 SSH 终端"],
    [activity.relayRequests ?? 0, "个中转请求"],
  ] as const).filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join("、");
}

export function canRestart(safety: RestartSafety): boolean {
  return safety.state === "known" && !activitySummary(safety.activity);
}

export function meetsUpdateMinimum(version?: string, minimum?: string | null): boolean {
  if (!minimum) return true;
  const parts = (value?: string) => /^v?(\d+)\.(\d+)\.(\d+)$/i.exec(value?.trim() ?? "")?.slice(1).map(Number);
  const a = parts(version), b = parts(minimum);
  return Boolean(a && b && (a[0] > b[0] ||
    (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])))));
}

export const AVAILABLE_PRESENTATION: UpdatePresentation = {
  status: "available", progress: 0, indeterminate: true, downloadedBytes: 0,
  totalBytes: null, bytesPerSec: 0, safety: { state: "checking" },
};
