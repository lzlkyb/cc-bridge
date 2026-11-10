import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useTerminalWorkspace } from "../../hooks/useTerminalWorkspace";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { useTerminalThemeMode } from "../../hooks/useTerminalAppearance";
import { useTerminalPreset } from "../../hooks/useTerminalPreset";
import { TERMINAL_SURFACE } from "../../lib/terminalTheme";
import type { SshConnection, SshConnectionList, SshCheckResult, StaticStatus } from "../../lib/types";
import { SshConnectionDialog } from "./SshConnectionDialog";
import type { SshSessionRef } from "./TerminalConnectionItem";
import { TerminalFilePanelHost } from "./TerminalFilePanelHost";
import { TerminalSidebar } from "./TerminalSidebar";
import { TerminalPanes } from "./TerminalPanes";
import { useTerminalSplit } from "./useTerminalSplit";
import { useTerminalTabCycling } from "../../hooks/useTerminalTabCycling";
import { SshEnableGate, SshMissingCard } from "./TerminalGates";
import { useTerminalViewState } from "./useTerminalViewState";
import { useSshSessions } from "./useSshSessions";
import { useTerminalCwds } from "./useTerminalCwds";
import { TerminalTabsBar } from "./TerminalTabsBar";
import { TerminalEmptyState } from "./TerminalEmptyState";
import { RestoreBanner } from "./TerminalRestore";
import { useSessionRestore } from "../../hooks/useSessionRestore";
import { useFileDrop } from "./useFileDrop";
import { useTerminalUpload } from "./useTerminalUpload";
import { TerminalDropLayer } from "./TerminalDropLayer";
import { TerminalSplitControls } from "./TerminalSplitControls";
import { TerminalFullscreenProvider } from "./TerminalFullscreenContext";
import { zoneOf, type DropZone } from "../../lib/dropHit";
import { forwardPanelOpen, offerForward } from "../../lib/sshTunnelStore";

/** SSH 工作区：共享侧栏，终端保活；首次使用仍需显式启用。 */
export function TerminalTab({ status, sidebarHost, sidebarCollapsed, onSidebarCollapsedChange, onNavigate, onChanged }: { status?: StaticStatus; sidebarHost: HTMLDivElement | null; sidebarCollapsed: boolean; onSidebarCollapsedChange: Dispatch<SetStateAction<boolean>>; onNavigate?: (tab: string, anchor?: string) => void; onChanged?: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<SshConnectionList, Error>({
    queryKey: ["sshConnections"],
    queryFn: () => invoke<SshConnectionList>("ssh_list_connections"),
  });

  const enabled = data?.enabled ?? false;
  const connections = data?.connections ?? [];

  const [check, setCheck] = useState<SshCheckResult | null>(null);
  // 文件管理面板：选中某连接后显示其 SFTP 浏览器（覆盖在右侧）。
  const [fileConn, setFileConn] = useState<SshConnection | null>(null);
  // 终端路径点击的初始定位（SshFileBrowser initialPath）。null = 走「上次上传目录」。
  const [filePath, setFilePath] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<SshConnection | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = useTerminalThemeMode();
  const preset = useTerminalPreset();
  const surface = TERMINAL_SURFACE[preset][mode];

  const ssh = useSshSessions();
  const { sessions, activeId } = ssh;
  // 会话恢复：连接列表就绪后按快照重建占位标签（不自动连接），之后 debounce 写快照。
  useSessionRestore({ ssh, connections, ready: data !== undefined });
  const { collapsed, setCollapsed, fullscreen, setFullscreen } = useTerminalViewState(rootRef, activeId, { collapsed: sidebarCollapsed, setCollapsed: onSidebarCollapsedChange });

  // 拖拽上传（终端侧）。只对**当前活动且未断开**的会话生效：没有会话就没有「传到哪台机器」。
  const termAreaRef = useRef<HTMLDivElement>(null);
  const activeSession = sessions.find((s) => s.sessionId === activeId);
  const splitCtl = useTerminalSplit({ ssh, activeSession: activeSession ?? null, areaRef: termAreaRef });
  // Ctrl+Tab / Ctrl+Shift+Tab 循环切标签（全屏时标签会溢出到滚动区外，靠它兜底）。
  useTerminalTabCycling(sessions.filter((s) => !s.splitOnly).map((s) => s.sessionId), activeId, ssh.setActiveId);
  const workspace = useTerminalWorkspace(sessions, activeId, splitCtl.split);
  const activeConn =
    activeSession && !activeSession.closedReason ? activeSession.conn : null;
  // 各会话的远端 cwd（OSC 7 探测，见 hooks/useTerminalOsc.ts）。拖拽上传拿它当目标目录，
  // 省掉「每次拖文件都问传到哪」——那正是文件面板侧早就免掉的一步。
  // 表本体与清理在 useTerminalCwds（会话移除 / 重连换 sessionId 后同步删旧 key）。
  const { onCwd, activeCwd } = useTerminalCwds(sessions, activeId);
  const up = useTerminalUpload(activeConn, activeCwd);
  const drop = useFileDrop({
    collectZones: () => {
      // 文件面板盖在终端之上时交给它自己的监听器。
      // 注意这里**不再**拿 up.busy 当排除条件：忙的时候也要收集拖放区，
      // 否则遮罩不出、也不提示，用户只知道「没反应」。接不接在 onDrop 里拿主意。
      if (fileConn || forwardPanelOpen() || !activeConn) return [];
      const z = zoneOf("terminal", termAreaRef.current);
      return z ? [z] : ([] as DropZone[]);
    },
    // 忙的时候不接（两个循环共用同一个 idRef，混在一起进度会打错），
    // 但**不能静默丢**：遮罩刚高亮过，接着什么都不发生比报个原因更让人困惑。
    onDrop: (_zone, paths) => {
      if (up.busy) {
        toast("正在传输中，等这批传完再拖", "info");
        return;
      }
      void up.dropped(paths);
    },
  });

  const openSession = (sessionId: string) => {
    workspace.setFocusedTabId(null);
    ssh.setActiveId(sessionId);
    ssh.patchMeta(sessionId, { bellAt: null }); // 激活即读，未读铃点清零。
    setFileConn(null);
  };
  const connect = (conn: SshConnection) => {
    workspace.setFocusedTabId(null);
    setFileConn(null);
    void ssh.connect(conn).then((sid) => sid && offerForward(conn));
  };
  // 另开一个（不复用现有标签）。
  const newTerminal = (conn: SshConnection) => {
    workspace.setFocusedTabId(null);
    setFileConn(null);
    void ssh.connect(conn, { newTab: true });
  };
  // 重连某会话回它自己的标签（断开横幅 / 恢复横幅 / 恢复占位卡共用）。
  // 🔴 返回 Promise：「全部恢复」靠它 await 出串行，`void` 掉就变成并发。
  const reconnectSession = useCallback((s: SshSessionRef) => {
    setFileConn(null);
    return ssh.connect(s.conn, { intoTab: s.tabId, forSplit: !!s.splitOnly });
  }, [ssh]);

  // 启用后探测系统 ssh 可用性（决定降级卡片）。
  useEffect(() => {
    if (!enabled) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    // 探测失败保持 check=null（视为未知：不弹降级卡、不阻断终端），只消掉 unhandled rejection。
    void invoke<SshCheckResult>("ssh_check")
      .then((r) => { if (!cancelled) setCheck(r); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const enableSsh = async () => {
    try {
      await invoke("save_config", { patch: { sshEnabled: true } });
      await queryClient.invalidateQueries({ queryKey: ["sshConnections"] });
    } catch (e) {
      toast(`启用失败：${e}`, "error");
    }
  };

  const removeConnection = async (id: string) => {
    // 先请求后端删除，成功后才断本地会话并清 UI——之前是先 dropConnection 再 invoke，
    // 后端失败时 UI 已移除而连接还在（假删除），下次刷新列表连接又冒出来。
    try {
      await invoke("ssh_delete_connection", { id });
      // 若文件面板正对着被删连接，一并关闭，避免面板残留报错。
      setFileConn((fc) => (fc && fc.id === id ? null : fc));
      ssh.dropConnection(id);
      setConfirmingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ["sshConnections"] });
    } catch (e) {
      toast(`删除失败：${e}`, "error");
    }
  };

  // ── 未启用：锁屏启用闸 ──
  if (!enabled) return <SshEnableGate onEnable={() => void enableSsh()} />;

  // ── 已启用但系统 ssh 不可用：降级卡片 ──
  if (check && !check.available) {
    return (
      <SshMissingCard
        check={check}
        onDismiss={() => setCheck(null)}
        onRecheck={() => void invoke<SshCheckResult>("ssh_check").then(setCheck).catch((e) => toast(`检测失败：${e}`, "error"))}
      />
    );
  }

  return (
    <TerminalFullscreenProvider fullscreen={fullscreen} status={status} sessions={sessions} onActivate={openSession} onNavigate={onNavigate} onChanged={onChanged} onExit={() => setFullscreen(false)} onToggleSplit={activeSession ? splitCtl.toggleSplit : undefined}>
    <div
      ref={rootRef} data-fullscreen={fullscreen || undefined}
      className="terminal-workspace flex h-full min-h-0 overflow-hidden bg-card"
    >
      {sidebarHost && createPortal(<TerminalSidebar
        embedded
        connections={connections}
        sessions={sessions}
        activeId={activeId}
        isLoading={isLoading}
        collapsed={collapsed}
        connectingId={ssh.connectingId}
        connectingIds={ssh.connectingIds} connectionErrors={ssh.connectionErrors}
        confirmingDelete={confirmingDelete}
        onSetCollapsed={setCollapsed}
        onNew={() => {
          setEditing(null);
          setShowDialog(true);
        }}
        onConnect={connect}
        onDisconnect={(sessionId) => void ssh.disconnect(sessionId)}
        onNewTerminal={newTerminal}
        onActivate={openSession}
        onOpenFiles={setFileConn}
        onEdit={(conn) => {
          setEditing(conn);
          setShowDialog(true);
        }}
        onDeleteRequest={setConfirmingDelete}
        onConfirmDelete={(id) => void removeConnection(id)}
        onCancelDelete={() => setConfirmingDelete(null)}
      />, sidebarHost)}

      <div
        ref={termAreaRef}
        className={
          fullscreen
            ? "terminal-fullscreen-area fixed inset-0 z-50 overflow-hidden"
            : "relative min-h-0 min-w-0 flex-1 overflow-hidden"
        }
        style={{ background: surface }}
      >
        {/* 终端视图（始终挂载，文件面板覆盖其上时仍保持后台会话存活） */}
        <div className="flex h-full min-h-0 flex-col">
          <TerminalDropLayer
            up={up}
            dropping={drop.zone === "terminal"}
            count={drop.count}
            cwd={activeCwd}
          />
          {sessions.length > 0 && (
            <TerminalTabsBar
              fullscreen={fullscreen} onExitFullscreen={() => setFullscreen(false)}
              sessions={sessions}
              metaBySession={ssh.metaBySession}
              activeId={activeId}
              onActivate={openSession}
              onDisconnect={(sessionId) => void ssh.disconnect(sessionId)}
              onCloseTab={ssh.closeTab}
              onRename={ssh.renameTab}
              // 新终端跟随当前操作的窗格，而分屏开关始终属于宿主标签。
              onNewTerminal={workspace.focusedSession && !workspace.focusedSession.closedReason ? () => newTerminal(workspace.focusedSession!.conn) : null}
              onToggleSplit={activeSession ? splitCtl.toggleSplit : null}
              splitActive={splitCtl.split !== null}
              splitControls={splitCtl.split && <TerminalSplitControls compact={fullscreen} split={splitCtl.split} onDirection={splitCtl.setDirection} onEqualize={() => splitCtl.setRatio(50)} onCollapse={() => activeSession && splitCtl.closeSplit(activeSession.tabId)}/>}
              onToolbarReady={workspace.setToolbarHost}
            />
          )}
          <RestoreBanner sessions={sessions} onReconnect={reconnectSession} />
          {/* 全部会话都挂载在 TerminalPanes 内（含分屏副格），仅当前可见；后台会话继续收输出 */}
          <TerminalPanes
            sessions={sessions}
            activeId={activeId}
            split={splitCtl.split}
            toolbarHost={workspace.toolbarHost}
            focusedTabId={workspace.focusedTabId}
            onFocusPane={workspace.setFocusedTabId}
            connections={connections}
            connectingId={ssh.connectingId}
            emptyState={<TerminalEmptyState collapsed={collapsed} onExpand={() => setCollapsed(false)} connections={connections} connectingId={ssh.connectingId} onNew={() => { setEditing(null); setShowDialog(true); }} onConnect={connect} />}
            dragSelectEnabled={status?.sshDragSelectEnabled ?? true}
            copyOnSelectEnabled={status?.sshCopyOnSelectEnabled ?? true}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((v) => !v)}
            onClosed={(s, reason) => ssh.markClosed(s.sessionId, reason)}
            onReconnect={reconnectSession}
            onCloseTab={(s) => ssh.closeTab(s.sessionId)}
            onCwd={onCwd}
            onMeta={(sessionId, p) => ssh.patchMeta(sessionId, p)}
            onOpenFilePath={(conn, p) => (setFileConn(conn), setFilePath(p))}
            onPickSplitConn={(conn) => void splitCtl.openSplit(conn, splitCtl.split?.dir ?? "h")}
            onCloseSplit={() => activeSession && splitCtl.closeSplit(activeSession.tabId)}
            onToggleDir={splitCtl.toggleDir}
            onSplitRatio={splitCtl.setRatio}
            onZoomPane={splitCtl.toggleZoom} onDisconnect={(sessionId) => void ssh.disconnect(sessionId)}
          />
        </div>

        {/* 文件管理 / 端口转发面板（覆盖在终端之上） */}
        <TerminalFilePanelHost
          conn={fileConn}
          initialPath={filePath ?? undefined}
          onBack={() => (setFileConn(null), setFilePath(null))}
          sessions={sessions} activeId={activeId}
          connections={connections}
          onConnect={ssh.connect}
        />
      </div>

      <SshConnectionDialog
        open={showDialog}
        initial={editing}
        connections={connections}
        onClose={() => setShowDialog(false)}
        onSaved={() => void queryClient.invalidateQueries({ queryKey: ["sshConnections"] })}
        onConnect={(conn, credentials) => {
          workspace.setFocusedTabId(null); setFileConn(null);
          void ssh.connect(conn, { newTab: true, credentials }).then((sid) => sid && offerForward(conn, credentials));
        }}
      />
    </div></TerminalFullscreenProvider>
  );
}
