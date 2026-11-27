import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { formatBytes } from "../../../../lib/utils";
import { GIB, maintenanceTitle, storageGroups, storageTime, type StorageOverview, type StorageUsage } from "../../../../lib/storageMaintenance";

interface Props {
  overview: StorageOverview;
  platform?: string;
  scanning: boolean;
  rescan: () => void;
  preview: () => void;
  showPolicy: () => void;
  showHistory: () => void;
  showDetail: (usage: StorageUsage) => void;
  openBackups: () => void;
}

export function StorageOverviewPanels({ overview, platform, scanning, rescan, preview, showPolicy, showHistory, showDetail, openBackups }: Props) {
  const { groups, history, policy, volume } = overview;
  const total = groups.reduce((sum, group) => sum + group.usedBytes, 0);
  const releasable = groups.reduce((sum, group) => sum + group.eligibleBytes, 0);
  const lowDisk = !!volume && volume.freeBytes < policy.minFreeGb * GIB;
  const backupBytes = groups.find(group => group.group === "backup")?.usedBytes ?? 0;
  const last = history[0];
  const percent = volume?.totalBytes ? Math.max(0, Math.min(100, (1 - volume.freeBytes / volume.totalBytes) * 100)) : null;

  return <>
    {lowDisk && volume && <div className="sm-warning" role="status"><Icon name="alertTriangle" size={19} /><div>
      <b>{volume.label} 空间不足</b><p>当前剩余 {formatBytes(volume.freeBytes)}，低于 {policy.minFreeGb} GB。{releasable > 0 && ` CC Bridge 预计可释放 ${formatBytes(releasable)}。`}</p>
    </div>{releasable > 0 && <Button variant="outline" size="sm" disabled={scanning} onClick={preview}>查看可清理项</Button>}</div>}
    {backupBytes > policy.backupLimitGb * GIB && <div className="sm-warning" role="status"><Icon name="alertTriangle" size={19} /><div>
      <b>备份占用超过阈值</b><p>文件备份已占用 {formatBytes(backupBytes)}，超过 {policy.backupLimitGb} GB。</p>
    </div><Button variant="outline" size="sm" onClick={openBackups}>管理备份</Button></div>}

    <section className="sm-panel" aria-label="磁盘概况">
      <div className="sm-summary-main">
        <div><span className="sm-metric-label"><Icon name="server" size={15} />{volume?.label ?? "应用数据磁盘"}</span>
          <div className="sm-number" data-warning={lowDisk || undefined}>{volume ? formatBytes(volume.freeBytes) : "—"}
            {volume && <small>可用 / {formatBytes(volume.totalBytes)}</small>}</div>
          {percent === null ? <p className="sm-meta">暂时无法读取磁盘剩余空间</p> :
            <div className="sm-disk-meter" role="meter" aria-label="磁盘使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><i style={{ width: `${percent}%` }} /></div>}
        </div>
        <div><span className="sm-metric-label"><Icon name="package" size={15} />CC Bridge 占用</span>
          <div className="sm-number">{formatBytes(total)}</div><p className="sm-meta">上次扫描 · {storageTime(overview.scannedAt)}</p></div>
        <div><span className="sm-metric-label"><Icon name="trash" size={15} />预计可释放</span>
          <div className="sm-number sm-releasable">{formatBytes(releasable)}</div><p className="sm-meta">过期日志、缓存和临时文件</p></div>
      </div>
      <div className="sm-summary-actions"><span className="sm-meta"><Icon name="monitor" size={14} />本机{platform === "windows" ? " Windows" : platform === "macos" ? " macOS" : ""}</span>
        <Button variant="outline" size="sm" onClick={rescan} isLoading={scanning} loadingText="扫描中…"><Icon name="refresh" size={14} />重新扫描</Button>
        <Button size="sm" disabled={!releasable || scanning} onClick={preview}><Icon name="eye" size={15} />预览清理</Button>
      </div>
    </section>

    <div className="sm-columns">
      <section className="sm-panel" aria-labelledby="sm-breakdown-title">
        <div className="sm-panel-heading"><h2 id="sm-breakdown-title">存储明细</h2></div>
        {total > 0 && <div className="sm-stack" aria-hidden="true">{groups.filter(group => group.usedBytes > 0).map(group => <i key={group.group} data-kind={group.group} style={{ flexGrow: group.usedBytes }} />)}</div>}
        <div className="sm-table">
          <div className="sm-table-header" aria-hidden="true"><span>类别</span><span>占用</span><span>可释放</span><span /></div>
          {groups.map(group => <button key={group.group} type="button" className="sm-storage-row" onClick={() => showDetail(group)}
            aria-label={`${storageGroups[group.group].label}，占用 ${formatBytes(group.usedBytes)}，查看详情`}>
            <span className="sm-category"><i data-kind={group.group} /><span><strong>{storageGroups[group.group].label}</strong><small>{storageGroups[group.group].description}</small></span></span>
            <span className="sm-size">{formatBytes(group.usedBytes)}</span>
            <span className={group.eligibleBytes ? "sm-size sm-eligible" : "sm-meta"}>{group.eligibleBytes ? formatBytes(group.eligibleBytes) : group.group === "backup" ? "单独管理" : group.group === "data" ? "保留" : "0 B"}</span>
            <Icon name="chevronRight" size={14} />
          </button>)}
        </div>
      </section>

      <section className="sm-panel sm-maintenance" aria-label="自动维护">
        <div className="sm-panel-heading"><div><h2>自动维护</h2><p>应用在托盘运行时仍会维护。</p></div><Button variant="outline" size="sm" onClick={showPolicy}>设置</Button></div>
        <dl className="sm-facts">
          <div><dt><Icon name="clock" size={15} />自动清理</dt><dd className={policy.autoClean ? "sm-on" : ""}>{policy.autoClean ? `每日 ${policy.dailyTime}` : "已关闭"}</dd></div>
          <div><dt><Icon name="bell" size={15} />磁盘空间提醒</dt><dd>{policy.diskAlert ? `低于 ${policy.minFreeGb} GB` : "已关闭"}</dd></div>
          <div><dt><Icon name="folder" size={15} />备份占用提醒</dt><dd>{policy.backupAlert ? `超过 ${policy.backupLimitGb} GB` : "已关闭"}</dd></div>
        </dl>
        <div className="sm-last"><h3>上次维护</h3>{last ? <><div><Icon name={last.skipped.length ? "alertTriangle" : "check"} size={15} /><strong>{storageTime(last.at)} · 释放 {formatBytes(last.freedBytes)}</strong></div>
          <p>{maintenanceTitle(last)}</p></> : <div className="sm-meta">暂无维护记录</div>}</div>
        <Button variant="link" size="sm" className="sm-record-link" onClick={showHistory}>查看维护记录<Icon name="chevronRight" size={14} /></Button>
      </section>
    </div>
    {!releasable && !overview.warnings.length && <div className="sm-empty"><Icon name="check" size={16} /><div><b>暂无可清理项目</b><p>过期日志和已失效的文件出现后会列在这里。</p></div></div>}
  </>;
}
