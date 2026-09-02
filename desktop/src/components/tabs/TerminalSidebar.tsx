import { useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import type { SshConnection } from "../../lib/types";
import { ConnectionListItem, type SshSessionRef } from "./TerminalConnectionItem";

/** 连接数达到这个量才显示搜索框。 */
const SEARCH_THRESHOLD = 6;

interface Props {
  connections: SshConnection[];
  sessions: SshSessionRef[];
  activeId: string | null;
  isLoading: boolean;
  collapsed: boolean;
  connectingId: string | null;
  confirmingDelete: string | null;
  onSetCollapsed: (v: boolean) => void;
  onNew: () => void;
  onConnect: (conn: SshConnection) => void;
  onDisconnect: (sessionId: string) => void;
  onActivate: (sessionId: string) => void;
  onOpenFiles: (conn: SshConnection) => void;
  onEdit: (conn: SshConnection) => void;
  onDeleteRequest: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
}

/**
 * 终端页左侧连接栏：展开态为连接列表，折叠态为 48px 图标 rail。
 * 宽度过渡由外层控制，内层固定宽，过渡时不重排、被 overflow-hidden 裁切做擦除动画。
 */
export function TerminalSidebar({
  connections,
  sessions,
  activeId,
  isLoading,
  collapsed,
  connectingId,
  confirmingDelete,
  onSetCollapsed,
  onNew,
  onConnect,
  onDisconnect,
  onActivate,
  onOpenFiles,
  onEdit,
  onDeleteRequest,
  onConfirmDelete,
  onCancelDelete,
}: Props) {
  // 连接多了就靠肉眼找不到了。数量少时不显示搜索框——288px 的侧栏本来就紧，
  // 三两个连接时它只是噪声。
  const [query, setQuery] = useState("");
  const showSearch = connections.length >= SEARCH_THRESHOLD;
  const shown = useMemo(() => {
    const k = query.trim().toLowerCase();
    if (!k || !showSearch) return connections;
    return connections.filter(
      (c) =>
        (c.name || "").toLowerCase().includes(k) ||
        c.host.toLowerCase().includes(k) ||
        c.username.toLowerCase().includes(k),
    );
  }, [connections, query, showSearch]);

  const width = collapsed ? 48 : 288;
  return (
    <div
      className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card transition-[width] duration-300 ease-out"
      style={{ width }}
    >
      {/* 固定宽 inner：外层 transition 宽度时 inner 不重排，被 overflow-hidden 裁切做擦除动画 */}
      <div className="flex h-full flex-col" style={{ width }}>
        {collapsed ? (
          <CollapsedRail
            connections={connections}
            sessions={sessions}
            activeId={activeId}
            onExpand={() => onSetCollapsed(false)}
            onPick={(conn) => {
              const session = sessions.find((s) => s.conn.id === conn.id);
              if (session) onActivate(session.sessionId);
              else onConnect(conn);
              onSetCollapsed(false);
            }}
          />
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
              <span className="text-sm font-medium">SSH 连接</span>
              <div className="flex items-center gap-1">
                <Button size="sm" className="h-7 px-2 text-xs" onClick={onNew}>
                  <Icon name="plus" size={14} /> 新建
                </Button>
                <button
                  type="button"
                  onClick={() => onSetCollapsed(true)}
                  title="收起侧栏 (Ctrl/Cmd+B)"
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Icon name="chevronLeft" size={16} />
                </button>
              </div>
            </div>
            {showSearch && (
              <div className="shrink-0 border-b border-border px-2 py-1.5">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`搜索 ${connections.length} 个连接（名称 / 主机 / 用户）`}
                  className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                />
              </div>
            )}
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {isLoading && <p className="p-2 text-xs text-muted-foreground">加载中…</p>}
              {!isLoading && connections.length === 0 && (
                <p className="p-3 text-center text-xs text-muted-foreground">
                  还没有连接，点「新建」添加一个。
                </p>
              )}
              {!isLoading && connections.length > 0 && shown.length === 0 && (
                <p className="p-3 text-center text-xs text-muted-foreground">
                  没有匹配「{query}」的连接
                </p>
              )}
              {shown.map((c) => {
                const session = sessions.find((s) => s.conn.id === c.id);
                // 跳板机名字在这里解（侧栏手里本来就有全量连接），
                // 不让列表项为一个名字去接整个连接数组。
                const jumpName = c.proxyJumpId
                  ? (connections.find((j) => j.id === c.proxyJumpId)?.name ?? "已失效")
                  : undefined;
                return (
                  <ConnectionListItem
                    key={c.id}
                    conn={c}
                    jumpName={jumpName}
                    session={session}
                    isActive={!!session && session.sessionId === activeId}
                    connecting={connectingId === c.id}
                    confirmingDelete={confirmingDelete === c.id}
                    onConnect={onConnect}
                    onDisconnect={onDisconnect}
                    onOpenFiles={onOpenFiles}
                    onEdit={onEdit}
                    onDeleteRequest={() => onDeleteRequest(c.id)}
                    onConfirmDelete={() => onConfirmDelete(c.id)}
                    onCancelDelete={onCancelDelete}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 折叠 rail 视图：48px 窄条，保留每个连接的首字母圆 + 状态点，可直点切换。
 * 顶部「展开」按钮（chevronLeft 旋转 180° 视觉为右箭头），hover 显示连接名 tooltip。
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
            className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-medium transition-all hover:bg-muted ${
              isActive ? "bg-primary/15 text-primary" : ""
            }`}
          >
            {initial}
            <span
              className={`absolute right-1 top-1 h-2 w-2 rounded-full ${
                connected ? "bg-green-500" : "bg-muted-foreground/40"
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
