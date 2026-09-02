import { Icon } from "../ui/icon";
import type { SshConnection } from "../../lib/types";

/** 一个已建立的 SSH 终端会话（TerminalTab 的 sessions 数组元素）。 */
export interface SshSessionRef {
  sessionId: string;
  conn: SshConnection;
  /**
   * 断开原因；null = 还连着。
   *
   * 断开后会话**不从数组里移除**：终端保留为只读态，历史输出仍可滚可选可复制，
   * 并提供「重新连接」。这也让误点 × 不再是不可逆的事故。
   */
  closedReason: string | null;
}

interface ConnectionListItemProps {
  conn: SshConnection;
  /**
   * 跳板机名称；undefined = 直连。
   *
   * 为什么值得占一个胶囊：连接失败时用户第一件要知道的事就是
   * 「这条到底是不是走跳板的」——否则会拿目标机的参数去排跳板机的故障。
   */
  jumpName?: string;
  /** 该连接当前是否有打开的会话（有则显示「断开」，否则显示「连接」）。 */
  session: SshSessionRef | undefined;
  isActive: boolean;
  connecting: boolean;
  /** 是否处于删除二次确认态（由父组件 confirmingDelete === conn.id 控制）。 */
  confirmingDelete: boolean;
  onConnect: (conn: SshConnection) => void;
  onDisconnect: (sessionId: string) => void;
  onOpenFiles: (conn: SshConnection) => void;
  onEdit: (conn: SshConnection) => void;
  onDeleteRequest: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/**
 * 连接列表单项：状态点 + 名称/地址 + 操作（连接/断开、文件、编辑、删除确认）。
 */
export function ConnectionListItem({
  conn,
  jumpName,
  session,
  isActive,
  connecting,
  confirmingDelete,
  onConnect,
  onDisconnect,
  onOpenFiles,
  onEdit,
  onDeleteRequest,
  onConfirmDelete,
  onCancelDelete,
}: ConnectionListItemProps) {
  return (
    <div
      className={`rounded-lg border p-2.5 transition-colors ${
        isActive
          ? "border-primary/50 bg-primary/5"
          : "border-border hover:bg-muted/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            isActive && !session?.closedReason
              ? "bg-green-500"
              : connecting
                ? "animate-pulse bg-muted-foreground/40"
                : "bg-muted-foreground/40"
          }`}
        />
        <span className="truncate text-sm font-medium">{conn.name || conn.host}</span>
        {jumpName && (
          <span
            title={`经跳板机「${jumpName}」中转`}
            className="shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-[9.5px] font-bold text-primary"
          >
            经 {jumpName}
          </span>
        )}
        {connecting && (
          <span className="text-[10px] text-muted-foreground">连接中…</span>
        )}
      </div>
      <div className="mt-0.5 truncate pl-4 text-xs text-muted-foreground">
        {conn.authType === "key" ? "🔑 " : ""}
        {conn.username}@{conn.host}:{conn.port}
      </div>
      <div className="mt-2 flex items-center gap-1 pl-4">
        {session && !session.closedReason ? (
          <button
            type="button"
            onClick={() => onDisconnect(session.sessionId)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            <Icon name="power" size={12} /> 断开
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onConnect(conn)}
            disabled={connecting}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {connecting ? (
              <>
                <Icon name="spinner" size={12} className="animate-spin" /> 连接中
              </>
            ) : (
              <>
                <Icon name="plug" size={12} /> 连接
              </>
            )}
          </button>
        )}
        <button
          type="button"
          disabled={!session || !!session.closedReason}
          title={
            session && !session.closedReason ? "管理该连接的远程文件" : "请先连接后再管理文件"
          }
          onClick={() => session && !session.closedReason && onOpenFiles(conn)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="folder" size={12} /> 文件
        </button>
        <button
          type="button"
          onClick={() => onEdit(conn)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          <Icon name="settings" size={12} /> 编辑
        </button>
        {confirmingDelete ? (
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={onConfirmDelete}
              className="rounded-md bg-destructive px-2 py-1 text-xs text-white"
            >
              确认
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={onDeleteRequest}
            className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-destructive"
          >
            <Icon name="trash" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

interface TerminalTabsBarProps {
  sessions: SshSessionRef[];
  activeId: string | null;
  onActivate: (sessionId: string) => void;
  /** 已连接的会话点 ×：断开（但保留标签）。 */
  onDisconnect: (sessionId: string) => void;
  /** 已断开的会话点 ×：真正移除标签。 */
  onCloseTab: (sessionId: string) => void;
}

/**
 * 终端标签栏：多会话时顶部横向标签。
 *
 * × 的语义分两档：**已连接 → 断开（标签保留）；已断开 → 关闭标签**。
 * 这个 11px 的 × 本来是一点就断、无确认；现在第一下只是进入可重连的断开态，
 * 误点不再丢历史输出——比加二次确认好，不多一步点击。
 */
export function TerminalTabsBar({
  sessions,
  activeId,
  onActivate,
  onDisconnect,
  onCloseTab,
}: TerminalTabsBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-2 py-1.5">
      {sessions.map((s) => {
        const closed = !!s.closedReason;
        const active = s.sessionId === activeId;
        return (
          <div
            key={s.sessionId}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
              active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <button
              type="button"
              onClick={() => onActivate(s.sessionId)}
              className="flex items-center gap-1.5"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  closed
                    ? "bg-destructive/60"
                    : active
                      ? "bg-green-500"
                      : "bg-muted-foreground/40"
                }`}
              />
              <span className={closed ? "line-through opacity-70" : undefined}>
                {s.conn.name || s.conn.host}
              </span>
              {s.conn.authType === "key" && <span>🔑</span>}
            </button>
            <button
              type="button"
              onClick={() => (closed ? onCloseTab(s.sessionId) : onDisconnect(s.sessionId))}
              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title={closed ? "关闭标签" : "断开（标签保留，可重连）"}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
