import { Icon } from "../ui/icon";
import { MenuItem } from "../ui/Menu";
import { MoreMenu, ButtonIcon } from "./SshTerminalMoreMenu";
import { setCmdPanelOpen } from "../../lib/terminalPanelStore";
import type { SshTerminalToolbarProps } from "./SshTerminalToolbar";

type Props = Omit<SshTerminalToolbarProps, "pane" | "compact" | "focused"> & { cmdOpen: boolean };

/** Session actions stay in that pane's header; appearance and layout belong to the workspace. */
export function TerminalPaneActions(p: Props) {
  const selecting = p.selectMode || p.shiftActive || p.dragSelecting;
  return <div className="terminal-pane-actions" aria-label={`${p.conn.name || p.conn.host}窗格操作`}>
    {p.inputErr && <span className="terminal-pane-alert text-destructive-ink" title={p.inputErr} role="status"><Icon name="alertTriangle" size={13}/><span className="sr-only">输入失败</span></span>}
    {selecting && <span className="terminal-pane-alert text-primary" title="选择模式：拖选复制"><Icon name="sliders" size={13}/><span className="sr-only">选择模式</span></span>}
    <ButtonIcon title="查找此窗格" onClick={p.onSearch}><Icon name="search" size={14}/></ButtonIcon>
    <MoreMenu portal selectMode={p.selectMode} onCopyScreen={p.onCopyScreen} onToggleSelectMode={p.onToggleSelectMode}
      onClear={p.onClear} onRepaint={p.onRepaint} onExport={p.onExport} extraItems={close => <>
        <MenuItem label="复制选中" icon="copy" hint="Ctrl+Shift+C" onClick={() => { p.onCopy(); close(); }}/>
        <MenuItem label="粘贴" icon="clipboard" hint="Ctrl+V" disabled={p.closed} onClick={() => { p.onPaste(); close(); }}/>
        <MenuItem label="粘贴剪贴板图片" icon="image" disabled={p.closed || p.imgBusy} onClick={() => { p.onPasteImage(); close(); }}/>
        <MenuItem label="命令历史" icon="history" active={p.cmdOpen} onClick={() => { setCmdPanelOpen(!p.cmdOpen); close(); }}/>
        <MenuItem label={p.fullscreen ? "退出工作区全屏" : "工作区全屏"} icon={p.fullscreen ? "collapse" : "expand"} hint="F11" onClick={() => { p.onToggleFullscreen(); close(); }}/>
        {p.onDisconnect && <MenuItem label="断开此会话（保留历史）" icon="power" disabled={p.closed} onClick={() => { p.onDisconnect?.(); close(); }}/>}<div className="my-1 border-t border-border"/>
      </>}/>
  </div>;
}
