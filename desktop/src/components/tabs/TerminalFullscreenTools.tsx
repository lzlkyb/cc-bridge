import { Icon } from "../ui/icon";
import { MenuItem } from "../ui/Menu";
import { MoreMenu, ButtonIcon } from "./SshTerminalMoreMenu";
import { setCmdPanelOpen } from "../../lib/terminalPanelStore";
import { useTerminalFullscreenActions } from "./TerminalFullscreenContext";
import type { SshTerminalToolbarProps } from "./SshTerminalToolbar";

/** Only the focused pane contributes actions to the shared full-screen title bar. */
export function TerminalFullscreenTools(p: SshTerminalToolbarProps & {cmdOpen: boolean}) {
  const actions = useTerminalFullscreenActions();
  return <div className="terminal-fullscreen-tools" aria-label={`${p.conn.name || p.conn.host}终端操作`}>
    {p.closed && <span className="terminal-fullscreen-alert text-destructive-ink" title="会话已断开"><Icon name="power" size={14}/><span className="sr-only">已断开</span></span>}
    {p.inputErr && <span className="terminal-fullscreen-alert text-destructive-ink" role="status" title={p.inputErr}><Icon name="alertTriangle" size={14}/><span className="sr-only">输入失败</span></span>}
    {(p.selectMode || p.shiftActive || p.dragSelecting) && <span className="terminal-fullscreen-alert text-primary" title="选择模式：拖选复制"><Icon name="sliders" size={14}/><span className="sr-only">选择模式</span></span>}
    <ButtonIcon title="查找当前终端（Ctrl+Shift+F）" onClick={p.onSearch}><Icon name="search" size={16}/></ButtonIcon>
    <MoreMenu portal appearance selectMode={p.selectMode} onCopyScreen={p.onCopyScreen} onToggleSelectMode={p.onToggleSelectMode} onClear={p.onClear} onRepaint={p.onRepaint} onExport={p.onExport}
      extraItems={close => <>
        <MenuItem label="复制选中" icon="copy" hint="Ctrl+Shift+C" onClick={() => { p.onCopy(); close(); }}/>
        <MenuItem label="粘贴" icon="clipboard" hint="Ctrl+V" disabled={p.closed} onClick={() => { p.onPaste(); close(); }}/>
        <MenuItem label="发送剪贴板图片" icon="image" hint="Ctrl+Shift+V" disabled={p.closed || p.imgBusy} onClick={() => { p.onPasteImage(); close(); }}/>
        <MenuItem label="命令历史" icon="history" active={p.cmdOpen} onClick={() => { setCmdPanelOpen(!p.cmdOpen); close(); }}/>
        {actions.terminalItems?.(close)}
      </>} footerItems={actions.applicationItems}/>
  </div>;
}
