import { useState, type ReactNode } from "react";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { Modal } from "../../../ui/Modal";
import { Switch } from "../../../ui/switch";
import { formatBytes } from "../../../../lib/utils";
import { cleanupKinds, maintenanceTitle, storageGroups, storageTime, type CleanupRun, type StoragePolicy, type StorageUsage } from "../../../../lib/storageMaintenance";

export function StorageDialog({ title, description, locked = false, close, footer, children }: {
  title: string; description?: string; locked?: boolean; close: () => void; footer?: ReactNode; children: ReactNode;
}) {
  return <Modal open onClose={close} ariaLabel={title} dismissible={!locked} closeOnOverlay={false}
    className="modal-surface sm-dialog" initialFocus={locked ? undefined : "[data-first]"} focusRefreshKey={title}>
    <div className="sm-dialog-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      {!locked && <Button variant="ghost" size="icon" aria-label="关闭弹窗" onClick={close}><Icon name="close" size={16} /></Button>}</div>
    <div className="sm-dialog-body">{children}</div>
    {footer && <div className="sm-dialog-foot">{footer}</div>}
  </Modal>;
}

export function StoragePolicyDialog({ policy, saving, error, close, save }: {
  policy: StoragePolicy; saving: boolean; error: string | null; close: () => void; save: (next: StoragePolicy) => void;
}) {
  const [draft, setDraft] = useState(policy);
  const update = <K extends keyof StoragePolicy>(key: K, value: StoragePolicy[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const validLimit = (number: number) => Number.isInteger(number) && number >= 1 && number <= 10_000;
  const valid = /^\d{2}:\d{2}$/.test(draft.dailyTime) && validLimit(draft.minFreeGb) && validLimit(draft.backupLimitGb);
  const footer = <><Button variant="outline" size="sm" onClick={close} disabled={saving} data-first>取消</Button>
    <Button size="sm" type="submit" form="sm-policy-form" disabled={!valid} isLoading={saving} loadingText="保存中…">保存设置</Button></>;
  return <StorageDialog title="自动维护设置" description="设置清理时间、提醒条件和占用阈值。" close={close} locked={saving} footer={footer}>
    <form id="sm-policy-form" onSubmit={event => { event.preventDefault(); if (valid && !saving) save(draft); }}>
      <fieldset disabled={saving}>
        <div className="sm-policy-row"><div><b>自动清理</b><p>应用运行时每天执行，启动时补跑错过的维护。</p></div>
          <Switch checked={draft.autoClean} ariaLabel="自动清理" onChange={value => update("autoClean", value)} /></div>
        <label className="sm-policy-row"><span><b>每天执行时间</b><span className="sm-policy-description">处理过期日志和确认失效的缓存及临时文件。</span></span>
          <input aria-label="每天执行时间" type="time" min="00:00" max="23:59" value={draft.dailyTime} disabled={!draft.autoClean} onChange={event => update("dailyTime", event.target.value)} /></label>
        <div className="sm-policy-row"><div><b>磁盘空间不足时提醒</b><p>监测保存 CC Bridge 数据的磁盘。</p></div>
          <Switch checked={draft.diskAlert} ariaLabel="磁盘空间不足时提醒" onChange={value => update("diskAlert", value)} /></div>
        <div className="sm-policy-row"><div><b>备份占用过高时提醒</b><p>达到阈值后提醒。备份可在文件管控中手动清理。</p></div>
          <Switch checked={draft.backupAlert} ariaLabel="备份占用过高时提醒" onChange={value => update("backupAlert", value)} /></div>
        <div className="sm-thresholds">
          <label>磁盘剩余低于<span><input type="number" min="1" max="10000" step="1" aria-label="磁盘剩余低于多少 GB"
            value={Number.isNaN(draft.minFreeGb) ? "" : draft.minFreeGb} disabled={!draft.diskAlert} onChange={event => update("minFreeGb", event.target.valueAsNumber)} /> GB</span></label>
          <label>备份占用超过<span><input type="number" min="1" max="10000" step="1" aria-label="备份占用超过多少 GB"
            value={Number.isNaN(draft.backupLimitGb) ? "" : draft.backupLimitGb} disabled={!draft.backupAlert} onChange={event => update("backupLimitGb", event.target.valueAsNumber)} /> GB</span></label>
        </div>
      </fieldset>
    </form>
    {error && <p className="sm-error" role="alert">保存失败。{error}</p>}
    <p className="sm-policy-note"><Icon name="info" size={15} />相同提醒 24 小时内最多出现一次。</p>
  </StorageDialog>;
}

export function StorageHistoryDialog({ runs, close }: { runs: CleanupRun[]; close: () => void }) {
  return <StorageDialog title="维护记录" description="最近 30 条自动维护和手动清理结果。" close={close}>
    {!runs.length && <p className="sm-meta">执行自动维护或手动清理后，结果会记录在这里。</p>}
    {runs.map((run, index) => <div key={`${run.at}-${run.source}-${index}`}>
      <div className="sm-history-row" data-partial={!!run.skipped.length || undefined}>
        <Icon name={run.skipped.length ? "alertTriangle" : "check"} size={16} />
        <div><b>{maintenanceTitle(run)}</b><p>{storageTime(run.at)} · {run.source === "manual" ? "手动" : "自动"}</p></div><strong>{formatBytes(run.freedBytes)}</strong>
      </div>
      {run.skipped.length > 0 && <details className="sm-history-details"><summary>查看跳过原因</summary><SkippedItems run={run} /></details>}
    </div>)}
  </StorageDialog>;
}

export function SkippedItems({ run }: { run: CleanupRun }) {
  return <>{run.skipped.map(issue => <div className="sm-result-skip" key={`${issue.kind}-${issue.reason}`}>
    <div><b>{cleanupKinds[issue.kind].label}</b><p>{issue.reason}</p></div><span>{issue.count > 0 ? `跳过 ${issue.count} 项` : "扫描失败"}</span>
  </div>)}</>;
}

const descriptions = {
  backup: "备份用于还原文件。可在文件管控中查看版本，按时间或目标体积预览清理，默认给每个文件保留最近一份。",
  logs: "审计日志和变更日志按各自设置的保留期限清理，模型中转日志按日保留。",
  update: "已失效的更新包和未完成的写入残件可清理。等待安装、下载中和可续传的更新包会保留。",
  temp: "只清理 CC Bridge 专用目录中已失效的中转文件。当前任务使用的文件、续传数据和未回传的 SSH 编辑副本会保留。",
  data: "数据库、连接配置、界面数据与历史记录只统计占用。",
};

export function StorageDetailDialog({ usage, close, preview, navigate }: {
  usage: StorageUsage; close: () => void; preview: () => void; navigate?: (tab: string, anchor: string) => void;
}) {
  const management = usage.group === "backup" ? { label: "管理备份", tab: "security", anchor: "set-backup" }
    : usage.group === "logs" ? { label: "日志保留设置", tab: "settings", anchor: "audit-retention" } : null;
  return <StorageDialog title={storageGroups[usage.group].label} description={`本机占用 ${formatBytes(usage.usedBytes)}`} close={close}
    footer={<><Button variant="outline" size="sm" onClick={close} data-first>关闭</Button>
      {management && navigate && <Button variant="outline" size="sm" onClick={() => navigate(management.tab, management.anchor)}>{management.label}</Button>}
      {usage.eligibleBytes > 0 && <Button size="sm" onClick={preview}>预览该类清理</Button>}</>}>
    <p className="sm-explanation">{descriptions[usage.group]}</p>
  </StorageDialog>;
}
