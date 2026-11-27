import { friendlyError, useOptionalUpdate, type UpdateState } from "../../../contexts/UpdateContext";
import { Button } from "../../ui/button";
import { SettingsRow } from "../../ui/SettingsRow";
import { ToggleRow } from "../../ui/ToggleRow";
import { ManualUpdateButton } from "../../update/ManualUpdateButton";

const statusLabel: Record<UpdateState["status"], string> = {
  idle: "可以检查新版本",
  uptodate: "已是最新版本",
  checking: "正在检查更新",
  available: "有新版本可下载",
  downloading: "正在下载",
  verifying: "正在验证安装包",
  staged: "安装包已就绪",
  installing: "正在安装更新",
  ready: "更新已安装，等待重启",
  error: "更新暂未完成",
};

const checkDate = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function SoftwareUpdateSettings({ currentVersion }: { currentVersion?: string }) {
  const updates = useOptionalUpdate();
  if (!updates) return null;
  const { status, update, portable, lastCheckedAt } = updates;
  const preparing = status === "downloading" || status === "verifying";
  const hasDetails = Boolean(update) && status !== "idle" && status !== "uptodate" && status !== "checking";
  const statusText = updates.downloadPaused ? "下载已取消，可以继续" :
    status === "downloading" && !updates.progressIndeterminate ? `正在下载 ${Math.min(100, updates.progress)}%` : statusLabel[status];
  const lastCheck = lastCheckedAt ? `上次检查 ${checkDate.format(lastCheckedAt)}` : "尚未完成检查";
  const version = currentVersion ?? update?.currentVersion;
  const error = status === "error" && updates.error ? friendlyError(updates.error, updates.errorCode).friendly : undefined;
  return <section className="settings-inner-section" aria-labelledby="update-settings-title">
    <h3 id="update-settings-title">软件更新</h3>
    {!portable && <ToggleRow id="toggle-update-preload" label="自动预下载更新"
      sub="在后台下载并验证安装包，就绪后提醒你安装"
      checked={updates.autoPreload} onChange={updates.setAutoPreload} />}
    <SettingsRow id="app-check-update" label={version ? `当前版本 v${version}` : "当前版本"} last
      sub={<><p>{lastCheck}{portable ? " · Windows 便携版" : ""}</p><p>{update?.version ? `v${update.version} · ` : ""}{statusText}</p></>}
      error={error}
      control={<div className="flex max-w-[220px] flex-wrap justify-end gap-1.5">
        {preparing && <Button size="sm" variant="ghost" disabled={!updates.canCancelPreparation} onClick={updates.cancelPreparation}>取消下载</Button>}
        {(portable || status === "error") && <ManualUpdateButton portable={portable} version={update?.version} />}
        {hasDetails && (status === "available" || status === "staged" || status === "error") &&
          <Button size="sm" variant="ghost" onClick={updates.manualCheckForUpdate}>重新检查</Button>}
        {hasDetails
          ? <Button size="sm" variant="outline" onClick={updates.openUpdateNotes}>{preparing ? "查看进度" : "查看更新"}</Button>
          : <Button size="sm" variant="outline" disabled={status === "checking"} onClick={updates.manualCheckForUpdate}>{status === "checking" ? "检查中…" : "检查更新"}</Button>}
      </div>} />
  </section>;
}
