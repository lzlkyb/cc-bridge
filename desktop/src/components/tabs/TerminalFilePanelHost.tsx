import { useEffect } from "react";
import { TerminalFilePanel } from "./TerminalFilePanel";
import { TerminalForwardPanel } from "./TerminalForwardPanel";
import { ForwardOnConnectPrompt } from "./ForwardOnConnectPrompt";
import { setForwardPanelConnId, useForwardPanelConnId } from "../../lib/sshTunnelStore";
import type { SshConnection } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";

/**
 * 终端页的覆盖层宿主（文件管理 / 端口转发）：TerminalTab 只持有「文件面板对着哪条连接」，
 * 断线判定与「重新连接」出口都收在这里（从 TerminalTab 拆出，体量棘轮）。
 * 转发面板的开关在 `sshTunnelStore`（入口在 portal 出去的侧栏里）。
 */
export function TerminalFilePanelHost({
  conn,
  initialPath,
  onBack,
  sessions,
  activeId,
  connections,
  onConnect,
}: {
  conn: SshConnection | null;
  initialPath?: string;
  onBack: () => void;
  sessions: SshSessionRef[];
  activeId: string | null;
  connections: SshConnection[];
  onConnect: (
    conn: SshConnection,
    opts?: { newTab?: boolean; intoTab?: string; forSplit?: boolean },
  ) => Promise<string | null>;
}) {
  const forwardId = useForwardPanelConnId();
  const forwardConn = connections.find((c) => c.id === forwardId);
  // 打开文件面板、切到另一个终端标签：用户要看的都不再是转发面板。
  useEffect(() => {
    if (conn) setForwardPanelConnId(null);
  }, [conn]);
  useEffect(() => setForwardPanelConnId(null), [activeId]);
  return (
    <>
      {conn && (
        <TerminalFilePanel
          conn={conn}
          initialPath={initialPath}
          onBack={onBack}
          disconnected={!sessions.some((s) => s.conn.id === conn.id && !s.closedReason)}
          onReconnect={() => {
            const s = sessions.find((x) => x.conn.id === conn.id);
            // 不调 reconnectSession：它会顺手 setFileConn(null) 把面板关掉，
            // 用户还要再点一次文件按钮才能回到刚才的位置。
            void (s
              ? onConnect(s.conn, { intoTab: s.tabId, forSplit: !!s.splitOnly })
              : onConnect(conn));
          }}
        />
      )}
      {forwardConn && (
        <TerminalForwardPanel key={forwardConn.id} conn={forwardConn} onBack={() => setForwardPanelConnId(null)} />
      )}
      <ForwardOnConnectPrompt />
    </>
  );
}
