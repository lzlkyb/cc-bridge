import { useState } from "react";
import { Icon } from "../ui/icon";
import type { SshConnection } from "../../lib/types";

/** 一个已建立的 SSH 终端会话（TerminalTab 的 sessions 数组元素）。 */
export interface SshSessionRef {
  /**
   * 标签的**稳定身份**，用作 React key。
   *
   * 🔴 不能拿 sessionId 当 key：重连会换一个 sessionId，key 一变组件就重挂，
   * xterm 实例跟着重建——而「断开后保留标签」的全部意义就是历史输出可读可复制，
   * 结果点一下「重新连接」就全没了。tabId 在标签的一生里不变。
   */
  tabId: string;
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
  /** 对该连接再开一个终端（仅在已有活会话时出现）。 */
  onNewTerminal: (conn: SshConnection) => void;
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
  onNewTerminal,
  onOpenFiles,
  onEdit,
  onDeleteRequest,
  onConfirmDelete,
  onCancelDelete,
}: ConnectionListItemProps) {
  // 「更多」菜单（另开终端/编辑/删除）的开合。低频操作折进菜单：
  // 常驻只留「连接/断开」+「文件」两个高频键（critique P1-3：20 连接 × 5 常驻键
  // 的扫描噪声，以及删除与编辑同权重并排的误触面）。
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
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
        {/* min-w-0 是 truncate 的前置条件：flex 子项默认 min-width:auto，缺了它 truncate 永不生效 */}
        <span className="min-w-0 truncate text-sm font-medium">{conn.name || conn.host}</span>
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
      {/* 操作行（critique P1-3 渐进披露）：常驻只留「连接/断开」+「文件」。
          原五键版需 px-1.5/gap-0.5 才塞进 250px；减到三键后恢复正常命中区。 */}
      <div className="mt-2 flex flex-wrap items-center gap-1 pl-4">
        {session && !session.closedReason ? (
          <button
            type="button"
            onClick={() => onDisconnect(session.sessionId)}
            className="flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            <Icon name="power" size={12} /> 断开
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onConnect(conn)}
            disabled={connecting}
            className="flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
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
          className="flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="folder" size={12} /> 文件
        </button>
        {confirmingDelete ? (
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={onConfirmDelete}
              className="whitespace-nowrap rounded-md bg-destructive px-2 py-1 text-xs text-white"
            >
              确认删除
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              取消
            </button>
          </span>
        ) : (
          <span className="relative ml-auto">
            <button
              type="button"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="另开终端 / 编辑 / 删除"
              onClick={() => setMenuOpen((o) => !o)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Icon name="more" size={13} />
            </button>
            {menuOpen && (
              <>
                {/* 透明遮罩：点菜单外任意处收起（不挡滚动，只挡一次点击） */}
                <div className="fixed inset-0 z-30" aria-hidden onClick={closeMenu} />
                <div
                  role="menu"
                  aria-label="连接更多操作"
                  className="animate-scale-in absolute bottom-full right-0 z-40 mb-1 w-36 rounded-lg border bg-popover p-1 shadow-pop"
                >
                  {session && !session.closedReason && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { closeMenu(); onNewTerminal(conn); }}
                      className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                    >
                      <Icon name="plus" size={12} /> 另开终端
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { closeMenu(); onEdit(conn); }}
                    className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <Icon name="settings" size={12} /> 编辑连接
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { closeMenu(); onDeleteRequest(); }}
                    className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
                  >
                    <Icon name="trash" size={12} /> 删除连接
                  </button>
                </div>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
