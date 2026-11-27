import { useContext } from "react";
import { Button } from "../ui/button";
import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";
import { TerminalFileWorkspace } from "./useTerminalFileWorkspace";

export function FileWorkspaceActions({ disconnected }: { disconnected?: boolean }) {
  const workspace = useContext(TerminalFileWorkspace);
  if (!workspace) return null;
  const terminal = workspace.mode === "terminal", local = workspace.mode === "local";
  const props = { variant: "outline", size: "sm", className: "h-7 whitespace-nowrap px-2 text-xs" } as const;
  return <>
    {terminal && <Button {...props} aria-pressed={workspace.following} onClick={workspace.toggleFollow} disabled={disconnected}>
      <Icon name="folder" size={13}/>{workspace.following ? "正在跟随终端" : "跟随终端目录"}
    </Button>}
    <Menu portal trigger={(expanded, toggle) => <Button {...props} onClick={toggle} aria-expanded={expanded} aria-haspopup="menu">
      <Icon name="monitor" size={13}/>视图<Icon name="chevronDown" size={12}/>
    </Button>}>
      {close => <>
        <MenuItem icon="server" label="远端单栏" disabled={!local && !terminal} onClick={() => { close(); if (terminal) workspace.toggleTerminal(); else if (local) workspace.toggleLocal(); }}/>
        <MenuItem icon="monitor" label="本机与远端双栏" disabled={local} onClick={() => { close(); workspace.toggleLocal(); }}/>
        <MenuItem icon="terminal" label="SSH 终端并排" disabled={terminal || disconnected} onClick={() => { close(); workspace.toggleTerminal(); }}/>
      </>}
    </Menu>
  </>;
}
