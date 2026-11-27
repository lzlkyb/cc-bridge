import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { toast } from "../../../ui/toast";
import { useAppHidden } from "../../../../lib/appVisibility";
import { useViewActive } from "../../../../lib/viewActivity";
import { invoke } from "../../../../lib/tauri";
import { CATEGORY_DESCRIPTIONS } from "../../../../lib/settingsCategories";
import { cleanupKinds, type CleanupKind, type StoragePolicy, type StorageOverview, type StorageUsage } from "../../../../lib/storageMaintenance";
import { StorageOverviewPanels } from "./StorageOverviewPanels";
import { StorageDetailDialog, StorageHistoryDialog, StoragePolicyDialog } from "./StorageDialogs";
import { StorageCleanupDialog } from "./StorageCleanupDialog";
import "../../../../storage-maintenance.css";

const queryKey = ["storage-maintenance"];
type View = { mode: "policy" | "history" } | { mode: "detail"; usage: StorageUsage } | { mode: "cleanup"; kinds?: CleanupKind[] };

export function StorageMaintenancePage({ platform, onNavigate }: {
  platform?: string; onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const active = useViewActive();
  const hidden = useAppHidden();
  const [view, open] = useState<View>();
  const client = useQueryClient();
  const overview = useQuery({ queryKey, enabled: active && !hidden, queryFn: () => invoke<StorageOverview>("get_storage_overview"),
    staleTime: 30_000, retry: false, refetchOnWindowFocus: false });
  const changed = () => { void client.invalidateQueries({ queryKey }); };
  const save = useMutation({
    mutationFn: (policy: StoragePolicy) => invoke<StoragePolicy>("save_storage_policy", { policy }),
    onSuccess: policy => {
      client.setQueryData<StorageOverview>(queryKey, current => current && { ...current, policy });
      open(undefined);
      toast("自动维护设置已保存", "success");
    },
  });
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("storage:changed", () => { void client.invalidateQueries({ queryKey }); }).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(() => {});
    return () => { disposed = true; stop?.(); };
  }, [active, client]);

  const close = () => open(undefined);
  const navigate = onNavigate && ((tab: string, anchor: string) => { close(); onNavigate(tab, anchor); });
  const data = overview.data;
  return <div className="sm-page">
    <header className="settings-page-heading sm-page-heading"><div><h1>存储与维护</h1><p>{CATEGORY_DESCRIPTIONS["set-storage"]}</p></div></header>
    {!data && overview.isPending && <div className="sm-panel sm-page-status" role="status"><Icon name="server" size={16} />正在扫描本机存储…</div>}
    {overview.isError && <div className="sm-warning" role="alert"><Icon name="alertTriangle" size={18} /><div>
      <b>无法扫描本机存储</b><p>{String(overview.error)}</p></div>
      <Button variant="outline" size="sm" onClick={() => void overview.refetch()} disabled={overview.isFetching}>重试</Button></div>}
    {data?.warnings.map(warning => <div className="sm-warning" role="status" key={warning}><Icon name="info" size={16} /><b>{warning}</b></div>)}
    {data && <StorageOverviewPanels overview={data} platform={platform} scanning={overview.isFetching} rescan={() => void overview.refetch()}
      preview={() => open({ mode: "cleanup" })} showPolicy={() => { save.reset(); open({ mode: "policy" }); }} showHistory={() => open({ mode: "history" })}
      showDetail={usage => open({ mode: "detail", usage })} openBackups={() => navigate?.("security", "set-backup")} />}

    {view?.mode === "cleanup" && <StorageCleanupDialog initialKinds={view.kinds} close={close} changed={changed} />}
    {view?.mode === "policy" && data && <StoragePolicyDialog policy={data.policy} saving={save.isPending} error={save.error ? String(save.error) : null} close={close} save={policy => save.mutate(policy)} />}
    {view?.mode === "history" && data && <StorageHistoryDialog close={close} runs={data.history} />}
    {view?.mode === "detail" && <StorageDetailDialog close={close} usage={view.usage} navigate={navigate} preview={() => {
      const group = view.usage.group;
      open({ mode: "cleanup", kinds: (Object.keys(cleanupKinds) as CleanupKind[]).filter(kind => cleanupKinds[kind].group === group) });
    }} />}
  </div>;
}
