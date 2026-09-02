import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import type { SshCheckResult } from "../../lib/types";

/**
 * 启用闸：ssh_enabled 默认关，首次进入需显式启用（遵循「默认关 + 多层闸」）。
 */
export function SshEnableGate({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md rounded-xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <Icon name="lock" size={26} className="text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold">启用 SSH 终端</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          在面板内直接连接远程 Linux 主机并操作终端。启用后，连接凭据仅存于本机，
          且<strong className="text-foreground">不会</strong>暴露给远程 Claude Code。
        </p>
        <Button className="mt-5 w-full" onClick={onEnable}>
          启用终端
        </Button>
      </div>
    </div>
  );
}

/**
 * 降级卡片：已启用但系统没有可用的 ssh，给出安装提示而不是让用户盲猜。
 */
export function SshMissingCard({
  check,
  onDismiss,
  onRecheck,
}: {
  check: SshCheckResult;
  onDismiss: () => void;
  onRecheck: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-lg rounded-xl border border-amber-500/30 bg-amber-500/10 p-6">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
          <Icon name="alertTriangle" size={18} />
          <h3 className="text-base font-semibold">未检测到 OpenSSH 客户端</h3>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          当前系统没有可用的 <code className="rounded bg-muted px-1">ssh</code>，
          无法建立终端连接。请按以下方式启用后重试：
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-black/80 p-3 text-xs text-green-300">
          {check.installHint}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onDismiss}>
            关闭
          </Button>
          <Button onClick={onRecheck}>重新检测</Button>
        </div>
      </div>
    </div>
  );
}
