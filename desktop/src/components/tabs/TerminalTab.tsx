import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import type {
  SshConnection,
  SshConnectionList,
  SshCheckResult,
  StaticStatus,
} from "../../lib/types";
import { SshConnectionDialog } from "./SshConnectionDialog";
import { SshTerminal } from "./SshTerminal";
import { SshFileBrowser } from "./SshFileBrowser";
import {
  ConnectionListItem,
  TerminalTabsBar,
  type SshSessionRef,
} from "./TerminalConnectionItem";

/**
 * 第 5 个 Tab「终端」：人在面板里手动操作 SSH 交互终端（首版密码登录）。
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
  // 多标签：每个已连接会话一个终端 tab；activeId 指向当前显示的会话。
  const [sessions, setSessions] = useState<SshSessionRef[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 文件管理面板：选中某连接后显示其 SFTP 浏览器（覆盖在右侧）。
  const [fileConn, setFileConn] = useState<SshConnection | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<SshConnection | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  // 连接进行中：列表项灰显「连接中…」+ 连接按钮 loading（纯前端态，无后端依赖）。
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // 侧栏折叠态（图标 rail）：localStorage 记忆，刷新/重开保持，零后端改动。
  const SIDEBAR_KEY = "cc-bridge.ssh-sidebar-collapsed";
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      /* 隐私模式等无 localStorage 时忽略 */
    }
  }, [collapsed]);
  // 快捷键 Ctrl/Cmd+B 切换折叠（VS Code 习惯）。终端聚焦时 keydown 仍冒泡到 window，
  // 故全局监听即可；preventDefault 阻止终端把该组合键当输入发往远端。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const enableSsh = async () => {
    try {
      await invoke("save_config", { patch: { sshEnabled: true } });
      await queryClient.invalidateQueries({ queryKey: ["sshConnections"] });
    } catch (e) {
      toast(`启用失败：${e}`, "error");
    }
  };

  // 连接：已开过该连接的终端则直接切到它；否则新建会话并加入标签栏。
  const connect = async (conn: SshConnection) => {
    const existing = sessions.find((s) => s.conn.id === conn.id);
    if (existing) {
      setActiveId(existing.sessionId);
      setFileConn(null);
      return;
    }
    setConnectingId(conn.id);
    try {
      const sessionId = await invoke<string>("ssh_connect", {
        args: {
          connectionId: conn.id,
          rows: 30,
          cols: 100,
        },
      });
      setSessions((prev) => [...prev, { sessionId, conn }]);
      setActiveId(sessionId);
      setFileConn(null);
      // 前台可见的连接成功提示（连接成功需在 UI 上让用户看到，而非仅 dev 后台日志）。
      toast(`SSH 已连接 ${conn.username}@${conn.host}:${conn.port}`, "success");
    } catch (e) {
      toast(`连接失败：${e}`, "error");
    } finally {
      setConnectingId(null);
    }
  };

  // 断开某个会话：杀进程 + 从标签栏移除。
  const disconnect = async (sessionId: string) => {
    try {
      await invoke("ssh_disconnect", { sessionId });
    } catch {
      /* 已断开也继续清理 UI */
    }
    setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    setActiveId((cur) => (cur === sessionId ? null : cur));
  };

  const removeConnection = async (id: string) => {
    // 同时断开该连接可能打开的终端会话。
    const linked = sessions.filter((s) => s.conn.id === id);
    for (const s of linked) {
      void invoke("ssh_disconnect", { sessionId: s.sessionId }).catch(() => {});
    }
    setSessions((prev) => prev.filter((s) => s.conn.id !== id));
    setActiveId((cur) =>
      linked.some((s) => s.sessionId === cur) ? null : cur,
    );
    // 若文件面板正对着被删连接，一并关闭，避免面板残留报错。
    setFileConn((fc) => (fc && fc.id === id ? null : fc));
    try {
      await invoke("ssh_delete_connection", { id });
      setConfirmingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ["sshConnections"] });
    } catch (e) {
      toast(`删除失败：${e}`, "error");
    }
  };

  // ── 未启用：锁屏启用闸 ──
  if (!enabled) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md rounded-xl border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <Icon name="lock" size={26} className="text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold">启用 SSH 终端</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            在面板内直接连接远程 Linux 主机并操作终端。启用后，连接凭据仅存于本机，
            且<strong className="text-foreground">不会</strong>暴露给远程 Claude Code。
          </p>
          <Button className="mt-5 w-full" onClick={enableSsh}>
            启用终端
          </Button>
        </div>
      </div>
    );
  }

  // ── 已启用但系统 ssh 不可用：降级卡片 ──
  if (check && !check.available) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-lg rounded-xl border border-amber-500/30 bg-amber-500/10 p-6">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
            <Icon name="alertTriangle" size={18} />
            <h3 className="text-base font-semibold">未检测到 OpenSSH 客户端</h3>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            当前系统没有可用的 <code className="rounded bg-muted px-1">ssh</code>，
            无法建立终端连接。请按以下方式启用后重试：
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-black/80 p-3 text-xs text-green-300">
            {check.installHint}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCheck(null)}>
              关闭
            </Button>
            <Button
              onClick={() =>
                void invoke<SshCheckResult>("ssh_check").then(setCheck)
              }
            >
              重新检测
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── 主界面：两栏 ──
  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* 左：连接列表 / 折叠 rail */}
      <div
        className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card transition-[width] duration-300 ease-out"
        style={{ width: collapsed ? 48 : 288 }}
      >
        {/* 固定宽 inner：外层 transition 宽度时 inner 不重排，被 overflow-hidden 裁切做擦除动画 */}
        <div className="flex h-full flex-col" style={{ width: collapsed ? 48 : 288 }}>
          {collapsed ? (
            <CollapsedRail
              connections={connections}
              sessions={sessions}
              activeId={activeId}
              onExpand={() => setCollapsed(false)}
              onPick={(conn) => {
                const session = sessions.find((s) => s.conn.id === conn.id);
                if (session) {
                  setActiveId(session.sessionId);
                  setFileConn(null);
                } else {
                  void connect(conn);
                }
                setCollapsed(false);
              }}
            />
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
                <span className="text-sm font-medium">SSH 连接</span>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setEditing(null);
                      setShowDialog(true);
                    }}
                  >
                    <Icon name="plus" size={14} /> 新建
                  </Button>
                  <button
                    type="button"
                    onClick={() => setCollapsed(true)}
                    title="收起侧栏 (Ctrl/Cmd+B)"
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Icon name="chevronLeft" size={16} />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                {isLoading && <p className="p-2 text-xs text-muted-foreground">加载中…</p>}
                {!isLoading && connections.length === 0 && (
                  <p className="p-3 text-center text-xs text-muted-foreground">
                    还没有连接，点「新建」添加一个。
                  </p>
                )}
                {connections.map((c) => {
                  const session = sessions.find((s) => s.conn.id === c.id);
                  return (
                    <ConnectionListItem
                      key={c.id}
                      conn={c}
                      session={session}
                      isActive={!!session && session.sessionId === activeId}
                      connecting={connectingId === c.id}
                      confirmingDelete={confirmingDelete === c.id}
                      onConnect={(conn) => void connect(conn)}
                      onDisconnect={(sessionId) => void disconnect(sessionId)}
                      onOpenFiles={setFileConn}
                      onEdit={(conn) => {
                        setEditing(conn);
                        setShowDialog(true);
                      }}
                      onDeleteRequest={() => setConfirmingDelete(c.id)}
                      onConfirmDelete={() => void removeConnection(c.id)}
                      onCancelDelete={() => setConfirmingDelete(null)}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 右：终端标签栏 + 终端（叠加文件管理面板） */}
      <div className="relative min-h-0 min-w-0 flex-1 rounded-xl border border-border bg-[#1e1e1e]">
        {/* 终端视图（始终挂载，文件面板覆盖其上时仍保持后台会话存活） */}
        <div className="flex h-full min-h-0 flex-col">
          {/* 标签栏 */}
          {sessions.length > 0 && (
            <TerminalTabsBar
              sessions={sessions}
              activeId={activeId}
              onActivate={(sessionId) => {
                setActiveId(sessionId);
                setFileConn(null);
              }}
              onDisconnect={(sessionId) => void disconnect(sessionId)}
            />
          )}
          {/* 全部会话都挂载，仅当前可见；后台会话继续收输出 */}
          <div className="relative min-h-0 flex-1">
            {sessions.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <div className="text-center">
                  <Icon name="terminal" size={28} className="mx-auto mb-2 opacity-50" />
                  从左侧选择一个连接开始
                </div>
              </div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.sessionId}
                  className="absolute inset-0"
                  style={{ display: s.sessionId === activeId ? "block" : "none" }}
                >
                  <SshTerminal
                    sessionId={s.sessionId}
                    conn={s.conn}
                    onClose={() => void disconnect(s.sessionId)}
                    visible={s.sessionId === activeId}
                    dragSelectEnabled={status?.sshDragSelectEnabled ?? false}
                  />
                </div>
              ))
            )}
          </div>
        </div>

        {/* 文件管理面板（覆盖在终端之上） */}
        {fileConn && (
          <div className="absolute inset-0 z-10 rounded-xl border border-border bg-card">
            <SshFileBrowser conn={fileConn} onBack={() => setFileConn(null)} />
          </div>
        )}
      </div>

      <SshConnectionDialog
        open={showDialog}
        initial={editing}
        onClose={() => setShowDialog(false)}
        onSaved={() =>
          void queryClient.invalidateQueries({ queryKey: ["sshConnections"] })
        }
      />
    </div>
  );
}

/**
 * 折叠 rail 视图：48px 窄条，保留每个连接的首字母圆 + 状态点，可直点切换。
 * 顶部「展开」按钮（arrowLeft 旋转 180° 视觉为右箭头），hover 显示连接名 tooltip。
 */
function CollapsedRail({
  connections,
  sessions,
  activeId,
  onExpand,
  onPick,
}: {
  connections: SshConnection[];
  sessions: SshSessionRef[];
  activeId: string | null;
  onExpand: () => void;
  onPick: (conn: SshConnection) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center gap-2 overflow-y-auto py-2">
      <button
        type="button"
        onClick={onExpand}
        title="展开 SSH 连接 (Ctrl/Cmd+B)"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon name="chevronLeft" size={16} style={{ transform: "rotate(180deg)" }} />
      </button>
      <div className="my-0.5 h-px w-6 shrink-0 bg-border" />
      {connections.map((c) => {
        const session = sessions.find((s) => s.conn.id === c.id);
        const isActive = !!session && session.sessionId === activeId;
        const connected = !!session;
        const initial =
          (c.name || c.username || "?").trim().charAt(0).toUpperCase() || "?";
        return (
          <button
            key={c.id}
            type="button"
            title={`${c.username}@${c.host}:${c.port}`}
            onClick={() => onPick(c)}
            className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-medium transition-all hover:bg-muted"
            style={{
              background: isActive ? "rgba(79,70,229,0.12)" : undefined,
              color: isActive ? "#4F46E5" : undefined,
            }}
          >
            {initial}
            <span
              className="absolute right-1 top-1 h-2 w-2 rounded-full"
              style={{ background: connected ? "#22c55e" : "#9ca3af" }}
            />
          </button>
        );
      })}
    </div>
  );
}
