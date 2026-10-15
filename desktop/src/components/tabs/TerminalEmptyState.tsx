import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import type { SshConnection } from "../../lib/types";
import { useTerminalThemeMode } from "../../hooks/useTerminalAppearance";
import { useTerminalPreset } from "../../hooks/useTerminalPreset";
import { terminalTheme } from "../../lib/terminalTheme";

/** 空态只承担当前任务：已有连接优先；展开列表后不重复左侧的入口。 */
export function TerminalEmptyState({
  collapsed,
  onExpand,
  onNew,
  onConnect,
  connections,
  connectingId = null,
}: {
  collapsed: boolean;
  onExpand: () => void;
  onNew: () => void;
  onConnect: (connection: SshConnection) => void;
  connections: SshConnection[];
  connectingId?: string | null;
}) {
  const mode = useTerminalThemeMode();
  const preset = useTerminalPreset();
  const hasConnections = connections.length > 0;
  const showPicker = hasConnections && collapsed;
  const title = !hasConnections ? "添加第一个 SSH 连接" : collapsed ? "连接到服务器" : "从左侧选择连接";
  const description = !hasConnections ? "添加服务器地址和登录方式，开始终端工作。" : collapsed ? "选择已保存的 SSH 连接，开始工作。" : "在 SSH 连接列表中选择服务器，打开终端。";
  return (
    <div className="terminal-empty" data-mode={mode} style={{ color: terminalTheme(mode, preset).foreground }}>
      <section className="terminal-empty-content" aria-label={title}>
        <Icon name="terminal" size={26} className="terminal-empty-symbol" />
        <h2>{title}</h2>
        <p className="terminal-empty-description">{description}</p>
        {showPicker && (
          <div className="terminal-picker">
            <div className="terminal-picker-heading">
              <span>已保存的连接</span>
              <button type="button" className="terminal-picker-expand" onClick={onExpand}>展开列表<Icon name="external" size={13} /></button>
            </div>
            <div className="terminal-picker-list">
              {connections.slice(0, 3).map(connection => {
                const name = connection.name || connection.host;
                const host = connection.host.includes(":") && !connection.host.startsWith("[") ? `[${connection.host}]` : connection.host;
                const address = `${connection.username}@${host}:${connection.port}`;
                const connecting = connectingId === connection.id;
                return (
                  <button key={connection.id} type="button" className="terminal-picker-host" disabled={Boolean(connectingId)} aria-label={`连接 ${name}`} aria-busy={connecting || undefined} title={`${name} · ${address}`} onClick={() => onConnect(connection)}>
                    <Icon name="server" size={16} />
                    <span className="terminal-picker-copy"><span className="terminal-picker-name">{name}</span><span className="terminal-picker-address">{address}</span></span>
                    {connecting ? <span className="terminal-picker-progress" role="status">连接中<Icon name="spinner" size={14} className="animate-spin" /></span> : <Icon name="arrowRight" size={15} className="terminal-picker-arrow" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {(!hasConnections || collapsed) && (
          <Button variant={hasConnections ? "outline" : "default"} className="terminal-empty-new" data-primary={!hasConnections || undefined} onClick={onNew}><Icon name="plus" size={15} />新建连接</Button>
        )}
      </section>
    </div>
  );
}
