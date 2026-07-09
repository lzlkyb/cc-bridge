import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useUpdate, type UpdateStatus } from "../../contexts/UpdateContext";
import type { StatusResponse } from "../../lib/types";

/**
 * 设置页「自动更新」卡片：idle/checking/uptodate/available/downloading/ready/error 七种状态，
 * 均来自 UpdateContext（Rust 侧 start_update 后台线程通过 update:* 事件驱动）。
 */
export function UpdateGroup({ status }: { status?: StatusResponse }) {
  const { status: updateStatus, update, progress, error, checkForUpdate, downloadAndInstall, restart } = useUpdate();

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="refresh" />}>自动更新</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <StatusText
            status={updateStatus}
            currentVersion={status?.version}
            update={update}
            progress={progress}
          />
          <ActionButton status={updateStatus} onCheck={checkForUpdate} onDownload={downloadAndInstall} onRestart={restart} />
        </div>
        {updateStatus === "downloading" && (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        {updateStatus === "available" && update?.body && (
          <p className="text-xs text-muted-foreground">{update.body}</p>
        )}
        {updateStatus === "error" && error && (
          <p className="break-all text-xs text-destructive/85">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}

function StatusText({
  status,
  currentVersion,
  update,
  progress,
}: {
  status: UpdateStatus;
  currentVersion?: string;
  update: { version: string } | null;
  progress: number;
}) {
  switch (status) {
    case "checking":
      return <span className="text-xs text-muted-foreground">当前版本 v{currentVersion ?? "?"}</span>;
    case "uptodate":
      return (
        <span className="flex items-center gap-1 text-xs text-success">
          <Icon name="check" size={12} />
          已是最新版本
        </span>
      );
    case "available":
      return <span className="text-xs font-semibold text-primary">发现新版本 v{update?.version}</span>;
    case "downloading":
      return <span className="text-xs text-muted-foreground">下载中… {progress}%</span>;
    case "ready":
      return <span className="text-xs text-success">v{update?.version} 已下载完成</span>;
    case "error":
      return <span className="text-xs text-destructive">更新出错</span>;
    default:
      return <span className="text-xs text-muted-foreground">当前版本 v{currentVersion ?? "?"}</span>;
  }
}

function ActionButton({
  status,
  onCheck,
  onDownload,
  onRestart,
}: {
  status: UpdateStatus;
  onCheck: () => void;
  onDownload: () => void;
  onRestart: () => void;
}) {
  if (status === "checking") {
    return (
      <Button size="sm" disabled>
        <Icon name="spinner" size={13} className="animate-spin" />
        检查中…
      </Button>
    );
  }
  if (status === "available") {
    return (
      <Button size="sm" onClick={onDownload}>
        <Icon name="download" size={13} />
        下载安装
      </Button>
    );
  }
  if (status === "downloading") {
    return (
      <Button size="sm" disabled>
        <Icon name="download" size={13} />
        下载安装
      </Button>
    );
  }
  if (status === "ready") {
    return <Button size="sm" onClick={onRestart}>重启以完成更新</Button>;
  }
  if (status === "error") {
    return (
      <Button size="sm" variant="outline" onClick={onCheck}>
        重试
      </Button>
    );
  }
  return (
    <Button size="sm" variant="outline" disabled={status === "uptodate"} onClick={onCheck}>
      检查更新
    </Button>
  );
}
