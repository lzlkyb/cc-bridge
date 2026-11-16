import { useState } from "react";
import type { StaticStatus } from "../../../lib/types";
import { useCurrentConnection } from "../../../hooks/useCurrentConnection";
import { useConnectionCopy } from "../../../hooks/useConnectionCopy";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { invoke } from "../../../lib/tauri";
import { toast } from "../../ui/toast";

export function CurrentAccessAddress({ status }: { status?: StaticStatus }) {
  const access = useCurrentConnection(status);
  const copy = useConnectionCopy(status);
  const [confirming, setConfirming] = useState(false);
  if (!access) return null;
  const confirm = async () => {
    setConfirming(true);
    try {
      await invoke("confirm_connection_update", { targetKey: access.targetKey });
      toast("已记录直连更新。", "success");
    } catch (error) {
      toast(`无法记录直连更新：${error}`, "error");
    } finally {
      setConfirming(false);
    }
  };
  return <div className="connection-address-summary" aria-label="接入地址摘要">
    <div className="connection-address-row"><div><span>{access.method === "stable" ? "服务器固定接入地址" : "本机直连接入地址"}</span>
      <code>{access.address || "完成配置后自动确认"}</code>{access.method === "stable" && <small>在服务器上使用</small>}</div>
      <Button type="button" size="sm" variant="outline" disabled={!access.canCopyAddress} onClick={() => void copy.copy("address")} aria-label="复制接入地址" aria-live="polite"><Icon name={copy.isCopied("address") ? "check" : "copy"} size={13}/>{copy.isCopied("address") ? "已复制" : "复制地址"}</Button>
    </div>
    {access.previousAddress && <p className="connection-previous-address">原接入地址 <code>{access.previousAddress}</code></p>}
    {access.canConfirmUpdate && <div className="connection-previous-address items-center">
      <span>在服务器执行更新命令并通过 <code>/mcp</code> 验证后，请确认。</span>
      <Button type="button" size="sm" variant="outline" isLoading={confirming} disabled={confirming} onClick={() => void confirm()}>已验证直连更新</Button>
    </div>}
  </div>;
}
