import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useTerminalWorkspace } from "../../hooks/useTerminalWorkspace";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { useTerminalThemeMode } from "../../hooks/useTerminalAppearance";
import { useTerminalPreset } from "../../hooks/useTerminalPreset";
import { TERMINAL_SURFACE } from "../../lib/terminalTheme";
import type {
  SshConnection,
  SshConnectionList,
  SshCheckResult,
  StaticStatus,
} from "../../lib/types";
import { SshConnectionDialog } from "./SshConnectionDialog";
import type { SshSessionRef } from "./TerminalConnectionItem";
import { TerminalFilePanel } from "./TerminalFilePanel";
import { TerminalSidebar } from "./TerminalSidebar";
import { TerminalPanes } from "./TerminalPanes";
import { useTerminalSplit } from "./useTerminalSplit";
import { SshEnableGate, SshMissingCard } from "./TerminalGates";
import { useTerminalViewState } from "./useTerminalViewState";
import { useSshSessions } from "./useSshSessions";
import { TerminalTabsBar } from "./TerminalTabsBar";
import { TerminalEmptyState } from "./TerminalEmptyState";
import { RestoreBanner } from "./TerminalRestore";
import { useSessionRestore } from "../../hooks/useSessionRestore";
import { useFileDrop } from "./useFileDrop";
import { useTerminalUpload } from "./useTerminalUpload";
import { TerminalDropLayer } from "./TerminalDropLayer";
import { zoneOf, type DropZone } from "../../lib/dropHit";

/**
 * SSH 工作区：连接列表投到应用侧栏，终端始终留在本页保活；首次使用仍需显式启用。
 */
export function TerminalTab({ status, sidebarHost, sidebarCollapsed, onSidebarCollapsedChange }: { status?: StaticStatus; sidebarHost: HTMLDivElement | null; sidebarCollapsed: boolean; onSidebarCollapsedChange: Dispatch<SetStateAction<boolean>> }) {
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
  // Ctrl+Shift+B 折叠共享侧栏；F11 只覆盖布局，不卸载终端。
  const { collapsed, setCollapsed, fullscreen, setFullscreen } = useTerminalViewState(rootRef, activeId, { collapsed: sidebarCollapsed, setCollapsed: onSidebarCollapsedChange });

  // 拖拽上传（终端侧）。只对**当前活动且未断开**的会话生效：
  // 没有会话就没有「传到哪台机器」。
  const termAreaRef = useRef<HTMLDivElement>(null);
  const activeSession = sessions.find((s) => s.sessionId === activeId);
  // 轻量双栏分屏（方案 A）：副格会话 splitOnly、不出现在标签栏，详见 useTerminalSplit。
  const splitCtl = useTerminalSplit({ ssh, activeSession: activeSession ?? null });
  const workspace = useTerminalWorkspace(sessions, activeId, splitCtl.split);
  const activeConn =
    activeSession && !activeSession.closedReason ? activeSession.conn : null;
  // 各会话的远端 cwd（OSC 7 探测，见 hooks/useTerminalOsc.ts）。拖拽上传拿它当目标目录，
  // 省掉「每次拖文件都问传到哪」——那正是文件面板侧早就免掉的一步。
  const [cwdBySession, setCwdBySession] = useState<Record<string, string | null>>({});
  const onCwd = useCallback((sessionId: string, cwd: string | null) => {
    setCwdBySession((m) => (m[sessionId] === cwd ? m : { ...m, [sessionId]: cwd }));
  }, []);
  const activeCwd = activeId ? (cwdBySession[activeId] ?? null) : null;
  const up = useTerminalUpload(activeConn, activeCwd);
  const drop = useFileDrop({
    collectZones: () => {
      // 文件面板盖在终端之上时交给它自己的监听器。
      // 注意这里**不再**拿 up.busy 当排除条件：忙的时候也要收集拖放区，
      // 否则遮罩不出、也不提示，用户只知道「没反应」。接不接在 onDrop 里拿主意。
      if (fileConn || !activeConn) return [];
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
    void ssh.connect(conn);
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
    void invoke<SshCheckResult>("ssh_check").then((r) => {
      if (!cancelled) setCheck(r);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // 切主题不再弹提醒。跑着的 TUI（Claude Code 这类在启动时探测背景明暗的程序）不会跟着
  // 变色——这条信息已写进设置页「终端风格」的说明里。放在那里是常驻可见的，而弹 toast 是
  // 每次切主题都打断一下，调一次配色能弹好几次。

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
        onRecheck={() => void invoke<SshCheckResult>("ssh_check").then(setCheck)}
      />
    );
  }

  // ── 主界面：两栏 ──
  return (
    <div
      ref={rootRef}
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

      {/* Portal only the connection list and toolbar; terminal panes keep their stable parents. */}
      <div
        ref={termAreaRef}
        className={
          fullscreen
            ? "fixed inset-0 z-50 overflow-hidden"
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
          />
          <RestoreBanner sessions={sessions} onReconnect={reconnectSession} />
          {sessions.length > 0 && (
            <TerminalTabsBar
              sessions={sessions}
              metaBySession={ssh.metaBySession}
              activeId={activeId}
              onActivate={openSession}
              onDisconnect={(sessionId) => void ssh.disconnect(sessionId)}
              onCloseTab={ssh.closeTab}
              // 新终端跟随当前操作的窗格，而分屏开关始终属于宿主标签。
              onNewTerminal={workspace.focusedSession && !workspace.focusedSession.closedReason ? () => newTerminal(workspace.focusedSession!.conn) : null}
              onToggleSplit={activeSession ? splitCtl.toggleSplit : null}
              splitActive={splitCtl.split !== null}
              onToolbarReady={workspace.setToolbarHost}
            />
          )}
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
            onCloseTab={(s) => (s.splitOnly ? splitCtl.closeSplit(s.tabId) : ssh.closeTab(s.sessionId))}
            onCwd={onCwd}
            onMeta={(sessionId, p) => ssh.patchMeta(sessionId, p)}
            onOpenFilePath={(conn, p) => (setFileConn(conn), setFilePath(p))}
            onPickSplitConn={(conn) => void splitCtl.openSplit(conn, splitCtl.split?.dir ?? "h")}
            onCloseSplit={() => activeSession && splitCtl.closeSplit(activeSession.tabId)}
            onToggleDir={splitCtl.toggleDir}
            onSplitRatio={splitCtl.setRatio}
          />
        </div>

        {/* 文件管理面板（覆盖在终端之上） */}
        {fileConn && (
          <TerminalFilePanel
            conn={fileConn}
            initialPath={filePath ?? undefined}
            onBack={() => (setFileConn(null), setFilePath(null))}
          />
        )}
      </div>

      <SshConnectionDialog
        open={showDialog}
        initial={editing}
        connections={connections}
        onClose={() => setShowDialog(false)}
        onSaved={() => void queryClient.invalidateQueries({ queryKey: ["sshConnections"] })}
      />
    </div>
  );
}
