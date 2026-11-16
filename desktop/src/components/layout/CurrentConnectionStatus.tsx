import type { StaticStatus } from "../../lib/types";
import { CONNECT_GUIDE_ANCHOR, connectionMethodLabel } from "../../lib/connectionAccess";
import { useCurrentConnection } from "../../hooks/useCurrentConnection";

export function CurrentConnectionStatus({ status, onNavigate }: { status?: StaticStatus; onNavigate?: (tab: string, anchor?: string) => void }) {
  const access = useCurrentConnection(status);
  if (!access) return null;
  return <button type="button" className="connection-topbar-status" data-tone={access.tone} onClick={() => onNavigate?.("connect", CONNECT_GUIDE_ANCHOR)}
    title={`${connectionMethodLabel(access)} · ${access.serverName} · ${access.title}`} aria-label={`当前接入：${connectionMethodLabel(access)}，${access.short}，查看接入`}>
    <span className="connection-status-dot"/><strong>{connectionMethodLabel(access)}</strong><span>{access.short}</span>
  </button>;
}
