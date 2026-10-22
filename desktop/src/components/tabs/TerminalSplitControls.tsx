import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";
import { TerminalAppearanceMenu } from "./TerminalAppearanceMenu";
import type { SplitInfo } from "./useTerminalSplit";

export function TerminalSplitControls({ split, onDirection, onEqualize, onCollapse, compact = false }: {
  split: SplitInfo; onDirection: (dir: "h" | "v") => void; onEqualize: () => void; onCollapse: () => void; compact?: boolean;
}) {
  return <div className="terminal-split-controls" aria-label="分屏布局">
    <Menu trigger={(open, toggle) => <button type="button" className="terminal-layout-button" aria-label="选择分屏方向" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
      <Icon name="monitor" size={14}/><span>{split.dir === "h" ? "左右" : "上下"}</span><Icon name="chevronDown" size={12}/>
    </button>}>
      {close => <>
        <MenuItem label="左右分屏" active={split.dir === "h"} onClick={() => { onDirection("h"); close(); }}/>
        <MenuItem label="上下分屏" active={split.dir === "v"} onClick={() => { onDirection("v"); close(); }}/>
        {compact && <><MenuItem label="恢复均分" disabled={!!split.zoomedTabId} onClick={() => { onEqualize(); close(); }}/><MenuItem label="收起分屏（保留会话）" onClick={() => { onCollapse(); close(); }}/></>}
      </>}
    </Menu>
    {!compact && <><button type="button" className="terminal-layout-button" onClick={onEqualize} disabled={!!split.zoomedTabId} title="恢复 50 / 50 比例">均分</button>
    <button type="button" className="terminal-layout-button" onClick={onCollapse} title="副格转为独立标签，连接与历史保留（Ctrl+Shift+D）">收起分屏</button>
    <TerminalAppearanceMenu/></>}
  </div>;
}
