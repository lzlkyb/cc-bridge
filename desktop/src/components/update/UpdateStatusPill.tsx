import { Icon } from "../ui/icon";
import { friendlyError, type UpdateInfo, type UpdateStatus } from "../../contexts/UpdateContext";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";

/**
 * 「关于」页的更新状态胶囊：把七态压成一个 pill（2026-10-22 从 AboutGroup 抽出）。
 *
 * 抽出的直接原因：AboutGroup 触发了组件体量门禁（407 行 > 登记的基线 401）。
 * 这里是完整的独立 UI 区块（状态 → 一个胶囊），属于门禁认可的「独立区块 → 子组件」
 * 拆分，而不是把行数搬进 hook。
 *
 * error 态胶囊只写「更新失败」，原因放进 `title` —— 胶囊宽度随行内布局变化，塞长文案
 * 会把版本号那一行撑乱。title 里同时带原始错误串，是用户反馈时唯一能复制到的技术细节
 * （后端 `update:error` 的 `code` 决定 friendly 措辞，见 UpdateContext.ERROR_TEXT）。
 */
export function UpdateStatusPill({
  status,
  update,
  progress,
  progressIndeterminate,
  bytesPerSec,
  downloadedBytes,
  autoRestartIn,
  error,
  errorCode,
  onOpenNotes,
}: {
  status: UpdateStatus;
  update: UpdateInfo | null;
  progress: number;
  progressIndeterminate: boolean;
  bytesPerSec: number;
  downloadedBytes: number;
  autoRestartIn?: number | null;
  error?: string | null;
  errorCode?: string | null;
  onOpenNotes?: () => void;
}) {
  if (status === "uptodate") {
    return (
      <span className="status-pill flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-[3px] text-xs font-semibold text-success-ink">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        已是最新
      </span>
    );
  }
  if (status === "available") {
    return (
      <span
        className="flex cursor-pointer items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-[3px] text-xs font-semibold text-warning-ink transition-colors hover:bg-warning/20"
        title="查看本次更新内容"
        onClick={(e) => {
          e.stopPropagation();
          onOpenNotes?.();
        }}
      >
        有新版本 v{update?.version}
      </span>
    );
  }
  if (status === "downloading") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-[3px] text-xs font-semibold text-primary">
        <Icon name="download" size={11} />
        {progressIndeterminate ? (
          // 无总大小（如 Gitee 源 chunked 不返回 Content-Length）：条纹滚动动画条 + 真实已下载字节/速率
          <>
            <span className="relative h-1 w-12 overflow-hidden rounded-full bg-primary/20">
              <span className="indet-fill" />
            </span>
            <span className="font-normal text-primary">{`已下载 ${formatBytes(downloadedBytes)} · ${formatBytesPerSec(bytesPerSec)}`}</span>
          </>
        ) : (
          <>
            <span>{progress}%</span>
            <span className="h-1 w-12 overflow-hidden rounded-full bg-primary/20">
              <span
                className="block h-1 rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              />
            </span>
            {bytesPerSec > 0 && <span className="font-normal text-primary">{formatBytesPerSec(bytesPerSec)}</span>}
          </>
        )}
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-[3px] text-xs font-semibold text-success-ink tabular-nums">
        {autoRestartIn ? `${autoRestartIn} 秒后重启` : "已下载"}
      </span>
    );
  }
  // error 必须可见：早期直接 return null，失败后只剩孤零零的「重试」，用户不知道为什么要点它。
  // cursor-help 提示这里可以悬停看详情。
  if (status === "error") {
    const friendly = error ? friendlyError(error, errorCode).friendly : "更新失败";
    return (
      <span
        className="flex cursor-help items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-[3px] text-xs font-semibold text-destructive-ink"
        title={error ? `${friendly}\n\n原因：${error}` : friendly}
      >
        <Icon name="alertTriangle" size={11} />
        更新失败
      </span>
    );
  }
  return null;
}
