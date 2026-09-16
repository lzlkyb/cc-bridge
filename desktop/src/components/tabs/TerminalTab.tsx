import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { useThemeMode } from "../../hooks/useThemeMode";
import { useTerminalPreset } from "../../hooks/useTerminalPreset";
import { TERMINAL_SURFACE } from "../../lib/terminalTheme";
import type {
  SshConnection,
  SshConnectionList,
  SshCheckResult,
  StaticStatus,
} from "../../lib/types";
import { SshConnectionDialog } from "./SshConnectionDialog";
import { SshTerminal } from "./SshTerminal";
import { SshFileBrowser } from "./SshFileBrowser";
import { TerminalSidebar } from "./TerminalSidebar";
import { SshEnableGate, SshMissingCard } from "./TerminalGates";
import { useTerminalViewState } from "./useTerminalViewState";
import { useSshSessions } from "./useSshSessions";
import { TerminalTabsBar } from "./TerminalTabsBar";
import { TerminalEmptyState } from "./TerminalEmptyState";
import { useFileDrop } from "./useFileDrop";
import { useTerminalUpload } from "./useTerminalUpload";
import { TerminalDropLayer } from "./TerminalDropLayer";
import { zoneOf, type DropZone } from "../../lib/dropHit";

/**
 * 第 5 个 Tab「终端」：人在面板里手动操作 SSH 交互终端。
 * 结构：启用闸（默认关）→ 两栏（左连接列表 / 右 xterm 终端）→ Windows 未装 ssh 降级卡片。
 * 遵循「默认关 + 多层闸」：ssh_enabled 默认关，首次进入需显式启用。
 */
export function TerminalTab({ status }: { status?: StaticStatus }) {
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
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<SshConnection | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = useThemeMode();
  const preset = useTerminalPreset();
  const surface = TERMINAL_SURFACE[preset][mode];

  const ssh = useSshSessions();
  const { sessions, activeId } = ssh;
  // 侧栏折叠 + 软件内全屏两个视图开关（含 Ctrl+B / F11 快捷键）。
  // 全屏选「盖住」而不是把状态提到 App 去条件隐藏：后者会让 Header/Tabs 卸载重挂，
  // 触发 TabsList 指示器重算与状态轮询抖动，而收益为零。
  const { collapsed, setCollapsed, fullscreen, setFullscreen } = useTerminalViewState(
    rootRef,
    activeId,
  );

  // 拖拽上传（终端侧）。只对**当前活动且未断开**的会话生效：
  // 没有会话就没有「传到哪台机器」。
  const termAreaRef = useRef<HTMLDivElement>(null);
  const activeSession = sessions.find((s) => s.sessionId === activeId);
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
    ssh.setActiveId(sessionId);
    setFileConn(null);
  };
  const connect = (conn: SshConnection) => {
    setFileConn(null);
    void ssh.connect(conn);
  };
  // 另开一个（不复用现有标签）。
  const newTerminal = (conn: SshConnection) => {
    setFileConn(null);
    void ssh.connect(conn, { newTab: true });
  };

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
    <div ref={rootRef} className="flex h-full min-h-0 gap-4">
      <TerminalSidebar
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
      />

      {/* 右：终端标签栏 + 终端（叠加文件管理面板）。
          overflow-hidden 不能省：里面的标签栏（bg-card）与终端画布都是不透明的直角子元素，
          不裁就会盖在父级圆角上——这正是「一连接圆角就消失」的原因（没连接时里面只有无背景
          的空状态，圆角露得出来，所以看着像是连接之后才坏的）。 */}
      <div
        ref={termAreaRef}
        className={
          fullscreen
            ? "fixed inset-0 z-50 overflow-hidden"
            : "relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border"
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
          {sessions.length > 0 && (
            <TerminalTabsBar
              sessions={sessions}
              activeId={activeId}
              onActivate={openSession}
              onDisconnect={(sessionId) => void ssh.disconnect(sessionId)}
              onCloseTab={ssh.closeTab}
              // 只在当前标签还连着时给「新终端」：已断开的标签旁边已经有「重新连接」了。
              onNewTerminal={activeConn ? () => newTerminal(activeConn) : null}
            />
          )}
          {/* 全部会话都挂载，仅当前可见；后台会话继续收输出 */}
          <div className="relative min-h-0 flex-1">
            {sessions.length === 0 ? (
              <TerminalEmptyState collapsed={collapsed} onExpand={() => setCollapsed(false)} />
            ) : (
              sessions.map((s) => (
                // 🔴 key 用 tabId 而不是 sessionId：重连会换 sessionId，key 一变组件就重挂、
                // xterm 跟着重建，断开前的历史输出全没——而保留标签就是为了那些输出。
                <div
                  key={s.tabId}
                  className="absolute inset-0"
                  style={{ display: s.sessionId === activeId ? "block" : "none" }}
                >
                  <SshTerminal
                    sessionId={s.sessionId}
                    conn={s.conn}
                    closedReason={s.closedReason}
                    onClosed={(reason) => ssh.markClosed(s.sessionId, reason)}
                    // 重连回**这个**标签：同一连接可能有多个标签，不指定就可能接到别人头上。
                    onReconnect={() => {
                      setFileConn(null);
                      void ssh.connect(s.conn, { intoTab: s.tabId });
                    }}
                    onCloseTab={() => ssh.closeTab(s.sessionId)}
                    visible={s.sessionId === activeId}
                    dragSelectEnabled={status?.sshDragSelectEnabled ?? false}
                    fullscreen={fullscreen}
                    onToggleFullscreen={() => setFullscreen((v) => !v)}
                    onCwd={(cwd) => onCwd(s.sessionId, cwd)}
                  />
                </div>
              ))
            )}
          </div>
        </div>

        {/* 文件管理面板（覆盖在终端之上） */}
        {fileConn && (
          <div className="absolute inset-0 z-10 bg-card">
            {/* key 不能省：侧栏在文件面板打开时仍可点，直接换到另一条连接时
                组件不会重挂，path / entries 还是上一条的——而当前目录会被回写成
                「上次上传目录」，等于把 A 的目录存成了 B 的。 */}
            <SshFileBrowser
              key={fileConn.id}
              conn={fileConn}
              onBack={() => setFileConn(null)}
            />
          </div>
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
