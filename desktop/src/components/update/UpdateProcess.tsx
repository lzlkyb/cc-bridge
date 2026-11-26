import { activitySummary, canRestart, type UpdatePresentation } from "../../lib/updatePresentation";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

export function UpdateProcess({ process, force = false }: { process: UpdatePresentation; force?: boolean }) {
  if (process.status === "available") return null;
  const { status, safety } = process;
  const pct = Math.min(100, Math.max(0, process.progress));
  return <section className="update-process" data-status={status} aria-label="更新状态">
    <div role="status" aria-live="polite" aria-atomic="true">
      {status === "checking" && <h3>正在重新检查更新…</h3>}
      {status === "downloading" && <>
        <div className="update-process-heading"><h3>正在下载更新</h3><strong>{process.indeterminate ? "下载中" : pct + "%"}</strong></div>
        <p>{force ? "安装包就绪后，可立即更新。" : "关闭弹框后，下载仍会继续。"}</p>
      </>}
      {status === "verifying" && <h3><Icon name="spinner" size={16} className="animate-spin" />正在验证安装包签名</h3>}
      {status === "installing" && <><h3><Icon name="spinner" size={16} className="animate-spin" />正在应用更新</h3><p>正在使用已下载的安装包。</p></>}
      {status === "staged" && <>
        <div className="update-process-heading"><h3><Icon name="shield" size={16} aria-hidden="true" />已下载并验证签名</h3>{process.totalBytes ? <span>{formatBytes(process.totalBytes)}</span> : null}</div>
        {safety.state === "known" && !canRestart(safety) && <p>{activitySummary(safety.activity)}仍在运行。请先保存工作并结束这些任务。</p>}
        {safety.state === "unknown" && <p>暂时无法确认任务状态，请重新检查。</p>}
        {process.error && <p role="alert" className="update-restart-error">安装暂未完成，可以使用本地安装包重试。</p>}
      </>}
      {status === "ready" && <>
        <h3><Icon name="check" size={18} aria-hidden="true" />更新已安装，重启后生效</h3>
        <p>{safety.state === "checking" ? "正在检查运行中的任务…" : safety.state === "unknown" ? "暂时无法确认任务状态，请重新检查后再重启。" : canRestart(safety) ? "可以重启应用。" : activitySummary(safety.activity) + "仍在运行，完成后即可重启。"}</p>
      </>}
      {status === "error" && <><h3><Icon name="alertTriangle" size={18} aria-hidden="true" />更新暂未完成</h3><p>{process.error || "请稍后重试。"}</p></>}
    </div>
    {status === "downloading" && <>
      <div className="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={process.indeterminate ? undefined : pct} aria-valuetext={process.indeterminate ? "总大小未知" : undefined}>
        <span className={process.indeterminate ? "update-progress-unknown" : ""} style={process.indeterminate ? undefined : { transform: "scaleX(" + pct / 100 + ")" }} />
      </div>
      <div className="update-download-metrics"><span>{formatBytes(process.downloadedBytes)}{process.totalBytes ? " / " + formatBytes(process.totalBytes) : " · 总大小未知"}</span><span>{process.bytesPerSec > 0 ? formatBytesPerSec(process.bytesPerSec) : "正在连接…"}</span></div>
    </>}
    {status === "ready" && process.error && <p role="alert" className="update-restart-error">重启未成功，请重试或手动重新打开软件。</p>}
  </section>;
}

export interface UpdateActionProps {
  onClose: () => void;
  onDownload: () => void;
  onDismiss: () => void;
  onInstall?: () => void;
  onRestart?: () => void;
  onRetry?: () => void;
  onRefreshSafety?: () => void;
  onQuit?: () => void;
  onRefreshPolicy?: () => void;
  checkingPolicy?: boolean;
  onFinishWork?: () => void;
}

export function UpdateActions({ process, onClose, onDownload, onDismiss, onInstall, onRestart, onRetry, onRefreshSafety, force = false, onQuit, onRefreshPolicy, checkingPolicy, onFinishWork }: UpdateActionProps & { process: UpdatePresentation; force?: boolean }) {
  const { status, safety } = process;
  const idle = canRestart(safety);
  const preparing = status === "downloading" || status === "verifying";
  return <footer className="update-dialog-footer">
    <p className="update-restart-note"><Icon name="info" size={14} aria-hidden="true" /><span>{status === "ready" ? "重启会关闭终端连接，请先保存终端中的工作。" : "安装时将关闭应用，请先保存当前工作。"}</span></p>
    <div className="update-dialog-actions">
      {(status === "available" || status === "staged") && !force && <button type="button" className="interactive update-ignore" onClick={() => { onDismiss(); onClose(); }}>忽略此版本</button>}
      {force && status === "error" && <Button variant="ghost" onClick={onRefreshPolicy} disabled={checkingPolicy}>{checkingPolicy ? "检查策略中…" : "重新检查策略"}</Button>}
      {force && safety.state === "known" && !idle && status !== "installing" && <Button variant="outline" onClick={onFinishWork}>保存当前工作</Button>}
      {status !== "installing" && (force
        ? <Button variant="outline" onClick={onQuit}>退出软件</Button>
        : <Button variant="outline" disabled={process.restarting} onClick={onClose}>{preparing ? "在后台继续" : status === "ready" ? "稍后重启" : "稍后提醒"}</Button>)}
      {status === "available" && <Button data-update-primary onClick={() => { onDownload(); if (!force) onClose(); }}><Icon name="download" size={15} aria-hidden="true" />下载更新</Button>}
      {preparing && <Button disabled>{status === "verifying" ? "正在校验" : "正在下载"}</Button>}
      {status === "installing" && <Button disabled>正在安装</Button>}
      {status === "checking" && <Button disabled>检查中…</Button>}
      {status === "error" && <Button data-update-primary onClick={onRetry}><Icon name="refresh" size={15} aria-hidden="true" />重试更新</Button>}
      {(status === "staged" || status === "ready") && (idle
        ? <Button data-update-primary disabled={process.restarting || (status === "staged" ? !onInstall || checkingPolicy : !onRestart)} onClick={status === "staged" ? onInstall : onRestart}>{status === "staged" ? (checkingPolicy ? "正在确认版本…" : "立即更新") : process.restarting ? "正在重启…" : "重启并体验"}</Button>
        : <Button disabled={safety.state === "checking" || !onRefreshSafety} onClick={onRefreshSafety}>{safety.state === "checking" ? "检查任务中…" : "重新检查任务"}</Button>)}
    </div>
  </footer>;
}
