import { TerminalFilePanel } from "./TerminalFilePanel";
import type { SshConnection } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";

/**
 * 终端页的文件管理覆盖层宿主：TerminalTab 只持有「面板对着哪条连接」，
 * 断线判定与「重新连接」出口都收在这里（从 TerminalTab 拆出，体量棘轮）。
 */
export function TerminalFilePanelHost({
  conn,
  initialPath,
  onBack,
  sessions,
  onConnect,
}: {
  conn: SshConnection;
  initialPath?: string;
  onBack: () => void;
  sessions: SshSessionRef[];
  onConnect: (
    conn: SshConnection,
    opts?: { newTab?: boolean; intoTab?: string; forSplit?: boolean },
  ) => Promise<string | null>;
}) {
  return (
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
  );
}
