import { useContext } from "react";
import { Button } from "../ui/button";
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
    <Button {...props} aria-pressed={local} onClick={workspace.toggleLocal}>
      <Icon name="folder" size={13}/>{local ? "返回单栏" : "本地双栏"}
    </Button>
    <Button {...props} aria-expanded={terminal} onClick={workspace.toggleTerminal} disabled={disconnected && !terminal}>
      <Icon name="terminal" size={13}/>{terminal ? "收起 SSH 终端" : "打开 SSH 终端"}
    </Button>
  </>;
}
