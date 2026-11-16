import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { applyAppearance, getAppearance } from "../../lib/appearance";
import { toggleTheme } from "../../lib/theme";
import { headerSecurityBadges } from "../../lib/headerSecurityBadges";
import { useViewActive } from "../../lib/viewActivity";
import type { StaticStatus } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";
import { SecurityBadgeGroup } from "../layout/SecurityBadgeGroup";
import { MenuItem } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { useServiceControl } from "../../hooks/useServiceControl";
import { useCurrentConnection } from "../../hooks/useCurrentConnection";
import { CurrentConnectionStatus } from "../layout/CurrentConnectionStatus";
import { TerminalGlobalSearch } from "./TerminalGlobalSearch";

interface Actions {
  safety?: ReactNode;
  terminalItems?: (close: () => void) => ReactNode;
  applicationItems?: (close: () => void) => ReactNode;
}
const Context = createContext<Actions>({});
export const useTerminalFullscreenActions = () => useContext(Context);

/** Keep workspace actions above the pane portals, so they always target the focused session. */
export function TerminalFullscreenProvider({children, fullscreen, status, sessions, onActivate, onNavigate, onChanged, onExit, onToggleSplit}: {
  children: ReactNode; fullscreen: boolean; status?: StaticStatus; sessions: SshSessionRef[];
  onActivate: (id: string) => void; onNavigate?: (tab: string, anchor?: string) => void;
  onChanged?: () => void; onExit: () => void; onToggleSplit?: () => void;
}) {
  const active = useViewActive();
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const service = useServiceControl(status, onChanged);
  const { busy } = service;
  const current = useCurrentConnection(status);
  const badges = useMemo(() => headerSecurityBadges(status, false, current), [status, current]);
  useEffect(() => { if (!active || !fullscreen) { setSearchOpen(false); setConfirmStop(false); } }, [active, fullscreen]);
  const changeServer = async (action: "start" | "stop") => {
    // The confirmation names an explicit action; a status poll must never reverse it.
    if (await service.run(action)) setConfirmStop(false);
  };
  const actions: Actions = {
    safety: <><CurrentConnectionStatus status={status} onNavigate={(tab, anchor) => { onExit(); onNavigate?.(tab, anchor); }}/><SecurityBadgeGroup compact badges={badges} onNavigate={(tab, anchor) => { onExit(); onNavigate?.(tab, anchor); }}/></>,
    terminalItems: close => <>
      <MenuItem label="搜索全部会话" icon="search" onClick={() => { close(); setSearchOpen(true); }}/>
      {onToggleSplit && <MenuItem label="切换分屏" icon="monitor" hint="Ctrl+Shift+D" onClick={() => { close(); onToggleSplit(); }}/>}
    </>,
    applicationItems: close => <>
      <div className="my-1 border-t border-border"/>
      <div className="px-2.5 pb-1 pt-2 text-xs text-muted-foreground">应用</div>
      <MenuItem label="切换应用明暗" icon="moon" onClick={() => { toggleTheme(); close(); }}/>
      <MenuItem label="切换柔光 / 经典风格" icon="palette" onClick={() => { applyAppearance(getAppearance() === "glass" ? "classic" : "glass"); close(); }}/>
      {status && <MenuItem label={busy ? "本机服务处理中…" : status.running ? "停止本机服务…" : "启动本机服务"} icon={status.running ? "pause" : "play"} disabled={busy} onClick={() => { close(); if (status.running) setConfirmStop(true); else void changeServer("start"); }}/>}
    </>,
  };
  return <Context.Provider value={actions}>
    {children}
    {fullscreen && active && searchOpen && createPortal(<div className="fixed inset-0 z-[60]"><TerminalGlobalSearch sessions={sessions} onActivate={onActivate} onClose={() => setSearchOpen(false)}/></div>, document.body)}
    <Modal open={fullscreen && confirmStop} onClose={() => { if (!busy) setConfirmStop(false); }} ariaLabel="停止本机服务" className="w-full max-w-sm rounded-xl modal-surface p-5">
      <h3 className="text-base font-semibold">停止本机服务？</h3>
      <p className="my-3 text-sm leading-relaxed text-muted-foreground">远程 AI 工具将暂时无法访问本机桥接服务，SSH 终端会话保持连接。</p>
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setConfirmStop(false)}>取消</Button><Button disabled={busy} isLoading={busy} onClick={() => void changeServer("stop")}>停止本机服务</Button></div>
    </Modal>
  </Context.Provider>;
}
