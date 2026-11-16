import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { invoke } from "../../lib/tauri";
import { dismissForwardOffer, startTunnel, usePendingForwardOffer } from "../../lib/sshTunnelStore";
import type { SshConnectionList } from "../../lib/types";

/** 连上终端后询问是否同时开启端口转发。只在用户主动连接、有启用的规则、且转发没在跑时出现。 */
export function ForwardOnConnectPrompt() {
  const offer = usePendingForwardOffer();
  const queryClient = useQueryClient();
  const [remember, setRemember] = useState(false);
  if (!offer) return null;
  const { conn, creds } = offer;
  const count = offer.rules.length;

  const answer = async (open: boolean) => {
    dismissForwardOffer();
    setRemember(false);
    if (open) void startTunnel(conn, creds);
    if (!remember) return;
    // 记不住不影响这次的选择，只是下次还会再问。
    try {
      const list = await invoke<SshConnectionList>("ssh_list_connections");
      const current = list.connections.find(c => c.id === conn.id);
      if (!current) throw new Error("连接已被移除");
      await invoke("ssh_save_connection", {
        args: { connection: { ...current, forwardAuto: open ? "connect" : "off" }, password: null, passphrase: null },
      });
      await queryClient.invalidateQueries({ queryKey: ["sshConnections"] });
    } catch (e) {
      toast(`记住选择失败：${e}`, "error");
    }
  };

  return (
    <div role="dialog" aria-label="同时开启额外手动转发" className="animate-scale-in absolute bottom-4 right-4 z-20 w-80 max-w-[calc(100%-2rem)] rounded-lg border bg-popover p-3 text-sm shadow-pop">
      <div className="flex items-start gap-2">
        <Icon name="arrowRight" size={14} className="mt-1 shrink-0 text-primary" />
        <p>「{conn.name || conn.host}」另有 {count} 条手动端口转发，是否同时开启？</p>
      </div>
      <label className="mt-2 flex items-center gap-2 pl-6 text-xs text-muted-foreground">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        记住选择（可在转发面板里改）
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void answer(false)}>仅连接终端</Button>
        <Button size="sm" onClick={() => void answer(true)}>开启额外转发</Button>
      </div>
    </div>
  );
}
