import { activitySummary, canRestart, type UpdatePresentation } from "../../lib/updatePresentation";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

export function UpdateProcess({ process }: { process: UpdatePresentation }) {
  if (process.status === "available") return null;
  const { status, safety } = process;
  const pct = Math.min(100, Math.max(0, process.progress));
  return <section className="update-process" data-status={status} aria-label="更新状态">
    <div role="status" aria-live="polite" aria-atomic="true">
      {status === "checking" && <h3>正在重新检查更新…</h3>}
      {status === "downloading" && <>
        <div className="update-process-heading"><h3>{pct >= 100 && !process.indeterminate ? "正在校验并安装" : "正在下载更新"}</h3><strong>{process.indeterminate ? "下载中" : `${pct}%`}</strong></div>
        <p>关闭弹框后仍会继续下载，完成后自动启动安装。</p>
      </>}
      {status === "ready" && <>
        <h3><Icon name="check" size={18} aria-hidden="true" />更新已安装，等你准备好</h3>
        <p>{safety.state === "checking" ? "正在检查运行中的任务…" : safety.state === "unknown" ? "暂时无法确认任务状态，请重新检查后再重启。" : canRestart(safety) ? "对话、后台成员与传输均已空闲，可以重启。" : `${activitySummary(safety.activity)}仍在运行，完成后即可重启。`}</p>
      </>}
      {status === "error" && <><h3><Icon name="alertTriangle" size={18} aria-hidden="true" />更新暂未完成</h3><p>{process.error || "请稍后重试。"}</p></>}
    </div>
    {status === "downloading" && <>
      <div className="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={process.indeterminate ? undefined : pct} aria-valuetext={process.indeterminate ? "总大小未知" : undefined}>
        <span className={process.indeterminate ? "update-progress-unknown" : ""} style={process.indeterminate ? undefined : { transform: `scaleX(${pct / 100})` }} />
      </div>
      <div className="update-download-metrics"><span>{formatBytes(process.downloadedBytes)}{process.totalBytes ? ` / ${formatBytes(process.totalBytes)}` : " · 总大小未知"}</span><span>{process.bytesPerSec > 0 ? formatBytesPerSec(process.bytesPerSec) : "正在连接…"}</span></div>
    </>}
    {status === "ready" && process.error && <p role="alert" className="update-restart-error">重启未成功，请重试或手动重新打开软件。</p>}
  </section>;
}

export function UpdateActions({ process, onClose, onDownload, onDismiss, onRestart, onRetry, onRefreshSafety }: {
  process: UpdatePresentation; onClose: () => void; onDownload: () => void;
  onDismiss: () => void; onRestart?: () => void; onRetry?: () => void; onRefreshSafety?: () => void;
}) {
  const { status, safety } = process;
  return <footer className="update-dialog-footer">
    <p className="update-restart-note"><Icon name={status === "ready" ? "refresh" : "info"} size={14} aria-hidden="true" /><span>{status === "ready" ? "重启会关闭终端连接，请先保存终端中的工作。" : "下载完成后自动启动安装器，请先保存当前工作。"}</span></p>
    <div className="update-dialog-actions">
      {status === "available" && <button type="button" className="interactive update-ignore" onClick={() => { onDismiss(); onClose(); }}>忽略此版本</button>}
      <Button variant="outline" disabled={process.restarting} onClick={onClose}>{status === "downloading" ? "后台下载" : status === "ready" ? "稍后重启" : "稍后提醒"}</Button>
      {status === "available" && <Button onClick={onDownload}><Icon name="download" size={15} aria-hidden="true" />下载并更新</Button>}
      {status === "downloading" && <Button disabled><Icon name="download" size={15} aria-hidden="true" />正在下载</Button>}
      {status === "checking" && <Button disabled>检查中…</Button>}
      {status === "error" && <Button onClick={onRetry}><Icon name="refresh" size={15} aria-hidden="true" />重新检查</Button>}
      {status === "ready" && (canRestart(safety) ? <Button disabled={process.restarting || !onRestart} onClick={onRestart}><Icon name="refresh" size={15} aria-hidden="true" />{process.restarting ? "正在重启…" : "重启并体验"}</Button> : <Button disabled={safety.state === "checking" || !onRefreshSafety} onClick={onRefreshSafety}>{safety.state === "checking" ? "检查任务中…" : "重新检查任务"}</Button>)}
    </div>
  </footer>;
}
