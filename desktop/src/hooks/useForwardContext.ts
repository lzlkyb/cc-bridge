import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, listen } from "../lib/tauri";
import type { ForwardContext } from "../lib/forwardOwnership";

export const forwardContextKey = ["ssh-forward-context"];

export function useForwardContext(connectionId: string) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: [...forwardContextKey, connectionId], queryFn: async ({ signal }) => {
    const context = await invoke<ForwardContext>("ssh_forward_context", { connectionId });
    signal.throwIfAborted();
    return context;
  } });
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 只作废本连接的上下文。老代码用 `forwardContextKey` 前缀匹配，任意一条
    // 连接的隧道事件都会把**所有**已挂载面板的上下文各 refetch 一遍（D3）。
    const key = [...forwardContextKey, connectionId];
    const invalidate = () => {
      if (!disposed) void client.invalidateQueries({ queryKey: key });
    };
    // `ssh_tunnel_status` 是进度流：一次启动会连发多条（认证成功、每条规则监听
    // 各一条），而面板的实时状态走 store、不靠这份上下文——逐条 refetch 纯属
    // 浪费，还会 cancel 在途请求重新发。合并 150ms 窗口，只认最后一次。
    // 归属/服务状态类事件（暂停、重连、接入变更）频率低且要马上反映，保持立即。
    const coalesced = () => {
      if (disposed) return;
      clearTimeout(timer);
      timer = setTimeout(invalidate, 150);
    };
    for (const event of ["stable_connect_changed", "mcp-status-changed"]) {
      void listen(event, invalidate).then(stop => {
        if (disposed) stop(); else { stops.push(stop); invalidate(); }
      }).catch(() => {});
    }
    void listen("ssh_tunnel_status", coalesced).then(stop => {
      if (disposed) stop(); else stops.push(stop);
    }).catch(() => {});
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "success" && event.query.queryKey[0] === "sshConnections") invalidate();
    });
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); for (const stop of stops) stop(); };
  }, [client, connectionId]);
  return query;
}
