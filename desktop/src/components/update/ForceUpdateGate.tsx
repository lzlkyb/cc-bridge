import { Button } from "../ui/button";
import { UpdateNotesDialog } from "./UpdateNotesDialog";
import { friendlyError, useUpdate } from "../../contexts/UpdateContext";
import { useUpdateRestartSafety } from "../../hooks/useUpdateRestartSafety";
import { meetsUpdateMinimum, type UpdatePresentation } from "../../lib/updatePresentation";

export function ForceUpdateGate() {
  const {
    forceUpdate, update, status, progress, progressIndeterminate, bytesPerSec,
    downloadedBytes, totalBytes, error, errorCode, restarting, startForcedUpdate,
    installPreparedUpdate, quitApp, restart, refreshForcePolicy, checkingPolicy,
    finishingWork, canFinishWork, workSeconds, finishCurrentWork, returnToUpdate,
    cancelPreparation, canCancelPreparation, downloadPaused, portable, retryUpdate,
  } = useUpdate();
  const { safety, refresh } = useUpdateRestartSafety(forceUpdate.active && status !== "installing");
  if (!forceUpdate.active) return null;

  if (finishingWork) {
    return <div className="update-finish-work" role="region" aria-label="强制更新待安装">
      <span>请保存当前工作 · 剩余 <time>{Math.floor(workSeconds / 60)}:{String(workSeconds % 60).padStart(2, "0")}</time></span>
      <Button size="sm" onClick={returnToUpdate}>返回更新</Button>
    </div>;
  }

  const verdict = forceUpdate.verdict;
  const minimum = verdict?.minSupportedVersion ?? "";
  const version = meetsUpdateMinimum(update?.version, minimum) && update ? update : {
    version: verdict?.latestVersion ?? minimum,
    currentVersion: verdict?.currentVersion,
  };
  const eligible = meetsUpdateMinimum(update?.version, minimum);
  let phase: UpdatePresentation["status"] = status === "idle" || status === "checking" || status === "uptodate" ? "available" : status;
  if (phase === "staged" && !eligible) phase = "available";
  const process: UpdatePresentation = {
    status: phase, progress, indeterminate: progressIndeterminate, bytesPerSec,
    downloadedBytes, totalBytes, safety, restarting, downloadPaused,
    error: phase === "ready" || phase === "staged" ? error : error ? friendlyError(error, errorCode).friendly : null,
  };

  return <UpdateNotesDialog
    open
    requirement={{ minimumVersion: minimum, reason: verdict?.message || "请安装受支持的版本后继续使用。" }}
    update={version}
    process={process}
    onClose={() => undefined}
    onDismiss={() => undefined}
    onDownload={startForcedUpdate}
    onInstall={installPreparedUpdate}
    onRestart={restart}
    onRetry={retryUpdate}
    onRefreshSafety={refresh}
    onQuit={quitApp}
    onRefreshPolicy={refreshForcePolicy}
    checkingPolicy={checkingPolicy}
    onFinishWork={canFinishWork ? finishCurrentWork : undefined}
    onCancelDownload={cancelPreparation}
    cancelling={!canCancelPreparation}
    portable={portable}
  />;
}
