import { useEffect, useState } from "react";
import { useAppHidden } from "../../lib/appVisibility";
import type { TunnelStatus } from "../../lib/types";
import { Icon } from "../ui/icon";

export function ForwardRecovery({ status }: { status: TunnelStatus }) {
  const hidden = useAppHidden();
  const [now, setNow] = useState(Date.now);
  const retryAt = status.state === "reconnecting" ? status.retryAt : null;
  useEffect(() => {
    if (!retryAt || hidden) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [retryAt, hidden]);

  if (status.state !== "reconnecting" && status.state !== "connecting") return null;
  const seconds = retryAt ? Math.ceil(Math.max(0, retryAt - now) / 1000) : null;
  const label = status.state === "reconnecting"
    ? seconds === null ? "等待自动重试" : seconds > 0 ? `${seconds} 秒后自动重试` : "即将重试"
    : status.phase === "auth" ? "正在验证 SSH 登录" : "正在建立 SSH 连接";
  return <div className="fp-read-state">
    <div><p><Icon name="refresh" size={14} className="mr-1 inline" aria-hidden="true"/>{status.attempt ? `第 ${status.attempt} 次尝试 · ` : ""}{label}</p>
      {status.lastFailure && <p className="mt-1 text-sm text-muted-foreground break-all">上次失败：{status.lastFailure}</p>}</div>
  </div>;
}
