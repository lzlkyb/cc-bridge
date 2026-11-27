import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { invoke } from "../../../../lib/tauri";
import { formatBytes } from "../../../../lib/utils";
import { cleanupKinds, maintenanceTitle, type CleanupItem, type CleanupKind, type CleanupRun, type StoragePreview } from "../../../../lib/storageMaintenance";
import { SkippedItems, StorageDialog } from "./StorageDialogs";

function itemNote(item: CleanupItem) {
  if (item.kind === "temp") return `上次运行遗留，已超过 ${item.retentionDays} 天`;
  if (item.kind === "update") return "旧版本更新包或失效的写入残件";
  return `超过 ${item.retentionDays} 天保留期`;
}

export function StorageCleanupDialog({ initialKinds, close, changed }: {
  initialKinds?: CleanupKind[]; close: () => void; changed: () => void;
}) {
  const [result, setResult] = useState<CleanupRun>();
  const [selection, setSelection] = useState<CleanupKind[] | undefined>(initialKinds);
  const preview = useQuery({
    queryKey: ["storage-cleanup-preview", useId()], queryFn: () => invoke<StoragePreview>("preview_storage_cleanup"),
    refetchOnWindowFocus: false, refetchOnReconnect: false, gcTime: 0, retry: false,
  });
  const apply = useMutation({
    mutationFn: (request: { token: string; kinds: CleanupKind[] }) => invoke<CleanupRun>("apply_storage_cleanup", request),
    onSuccess: value => { setResult(value); changed(); },
  });
  const items = preview.data?.items ?? [];
  const selected = selection ?? items.map(item => item.kind);
  const included = items.filter(item => selected.includes(item.kind));
  const bytes = included.reduce((sum, item) => sum + item.bytes, 0);
  const refreshing = preview.isFetching;
  const pending = apply.isPending;
  const refresh = () => { apply.reset(); void preview.refetch(); };

  if (result) {
    return <StorageDialog title={maintenanceTitle(result)} description="本次维护只处理了 CC Bridge 管理的本机文件。" close={close}
      footer={<>{result.skipped.length > 0 && <Button variant="outline" size="sm" onClick={() => {
        setSelection(result.skipped.map(issue => issue.kind)); setResult(undefined); refresh();
      }}>预览重试</Button>}<Button size="sm" onClick={close} data-first>完成</Button></>}>
      <div className="sm-result" data-partial={!!result.skipped.length || undefined} role="status">
        <Icon name={result.skipped.length ? "alertTriangle" : "check"} size={21} />
        <div><strong>已释放 {formatBytes(result.freedBytes)}</strong><p>{result.removedCount ? `共清理 ${result.removedCount} 项。` : "没有删除文件。"}
          {result.recorded ? " 结果已记入维护记录。" : " 本次结果无法写入维护记录。"}</p></div>
      </div><SkippedItems run={result} />
    </StorageDialog>;
  }

  const confirm = () => {
    if (preview.data && included.length && !refreshing && !pending) apply.mutate({ token: preview.data.token, kinds: included.map(item => item.kind) });
  };
  const footer = <><span className="sm-footer-total" aria-live="polite">预计释放 <strong>{refreshing ? "—" : formatBytes(bytes)}</strong></span>
    <Button variant="outline" size="sm" onClick={close} disabled={pending} data-first>取消</Button>
    <Button variant="destructive" size="sm" className="sm-danger" disabled={refreshing || !included.length || preview.isError || apply.isError}
      isLoading={pending} loadingText="清理中…" onClick={confirm}><Icon name="trash" size={14} />确认清理</Button></>;

  return <StorageDialog title="清理预览" description="核对以下项目，取消勾选即可保留。清理后无法恢复。" close={close} locked={pending} footer={footer}>
    {(preview.isError || apply.isError) && <div role="alert" className="sm-error"><span>{String(preview.error ?? apply.error)}</span>
      <Button variant="outline" size="sm" disabled={refreshing} onClick={refresh}>重新预览</Button></div>}
    {refreshing && <p className="sm-meta sm-preview-status" role="status">正在检查可清理项目…</p>}
    {!refreshing && !preview.isError && <div className="sm-preview-list" aria-label="可清理项目">
      {items.map(item => <label className="sm-preview-row" key={item.kind}>
        <input type="checkbox" checked={selected.includes(item.kind)} disabled={pending} onChange={event => {
          const checked = event.target.checked;
          setSelection(checked ? [...selected, item.kind] : selected.filter(kind => kind !== item.kind));
        }} />
        <span><strong>{cleanupKinds[item.kind].label}</strong><small>{itemNote(item)} · {item.count} 项</small></span>
        <strong className="sm-size">{formatBytes(item.bytes)}</strong>
      </label>)}
      {!items.length && <p className="sm-meta">目前没有符合清理条件的文件。</p>}
    </div>}
    {preview.data?.warnings.map(warning => <p className="sm-meta sm-preview-status" key={warning}>{warning}</p>)}
    <div className="sm-protected"><Icon name="shield" size={17} /><div><b>这些内容会保留</b>
      <p>备份、使用中的更新包与传输文件、未回传的 SSH 编辑副本、连接配置、凭据和历史记录。远端项目文件和 Claude Code 原始历史也会保留。</p></div></div>
  </StorageDialog>;
}
