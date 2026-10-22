import { useLiveStatus } from "../../hooks/useLiveStatus";
import { useChangeClass } from "../../hooks/useChangeClass";
import { useDashboardMotion } from "../../hooks/useDashboardMotion";

/** A successful status update is distinct from a real remote request. */
export function DashboardSync({ running }: { running: boolean }) {
  const { dataUpdatedAt, isError, isRefetchError } = useLiveStatus();
  const failed = isError || isRefetchError;
  const motion = useDashboardMotion();
  const pulse = useChangeClass(dataUpdatedAt, "dashboard-sync--updated", 650, motion && running && !failed);
  const time = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString("zh-CN", {hour12: false}) : "";
  const label = failed ? "更新失败" : time ? `已更新 ${time}` : "等待同步";
  return <span className={`dashboard-sync ${pulse}`} data-tone={failed ? "error" : running ? "live" : "idle"} title={failed ? `状态更新失败${time ? `，上次更新 ${time}` : ""}` : `状态数据${time ? `更新于 ${time}` : "尚未返回"}`}>
    <i aria-hidden="true"/>
    <span>服务状态</span>
    <span className="dashboard-sync-time">{label}</span>
  </span>;
}
