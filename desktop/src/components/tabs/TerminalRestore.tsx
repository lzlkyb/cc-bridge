import { useState } from "react";
import { Icon } from "../ui/icon";
import type { SshSessionRef } from "./TerminalConnectionItem";

/**
 * 终端会话恢复的两个 UI（方案 A：骨架恢复 + 手动重连，无自动连接行为）。
 *
 * 占位标签 closedReason 用 "restored" 哨兵：不会走 SshTerminal 的断开渲染，
 * 也不会被 markClosed 的 toast 误碰（那些只在真实会话上发生）。
 */

/** 「上次会话」占位卡：显示主机身份 + 恢复/关闭。挂在原 SshTerminal 的位置。 */
export function RestoredTabPlaceholder({
  s,
  onReconnect,
  onCloseTab,
}: {
  s: SshSessionRef;
  onReconnect: () => void;
  onCloseTab: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-card p-4">
      <div className="text-xs text-muted-foreground">上次会话（未连接）</div>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon name="server" size={14} className="text-muted-foreground" />
        <span className="max-w-56 truncate">{s.conn.name || s.conn.host}</span>
      </div>
      <div className="font-mono text-xs text-muted-foreground">
        {s.conn.username}@{s.conn.host}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={onReconnect}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90"
        >
          恢复连接
        </button>
        <button
          type="button"
          onClick={onCloseTab}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          关闭标签
        </button>
      </div>
    </div>
  );
}

/** 标签栏下方的恢复横幅：N 个上次会话待重连，可一键全部恢复（逐个串行连）。 */
export function RestoreBanner({
  sessions,
  onReconnect,
}: {
  sessions: SshSessionRef[];
  /**
   * 🔴 **必须返回 Promise**：`ssh_connect` 是异步的，`onReconnect` 若声明成 `void`
   * 就永远拿不到「这一条连完了」的信号，循环会在同一 tick 里把全部连接一起发出去，
   * 撞远端 `MaxSessions`（注释写「串行」而实际全并发，就是这里漏的类型）。
   */
  onReconnect: (s: SshSessionRef) => void | Promise<unknown>;
}) {
  const restored = sessions.filter((s) => s.closedReason === "restored" && !s.splitOnly);
  // 进度用「已发起条数」而非「已成功」：失败的也会 toast 说明原因并继续下一条。
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // 本次忽略：只是当次会话不想被提示（占位卡仍在标签栏，随时可手动恢复），故不持久化。
  const [dismissed, setDismissed] = useState(false);
  if (restored.length === 0 || dismissed) return null;
  const running = progress !== null;
  const handleAll = async () => {
    if (running) return;
    const list = restored; // 连接成功后这些占位会转正、列表会缩短，先固定住本次的批次
    for (let i = 0; i < list.length; i++) {
      setProgress({ done: i, total: list.length });
      await onReconnect(list[i]); // 串行连，避免并发撞远端 MaxSessions
    }
    setProgress(null);
  };
  return (
    // 底色必须是**不透明** bg-card：这条横幅渲染在终端画布上（终端有自己的明暗设置，
    // 浅色应用 + 深色画布是合法组合），半透明主题色叠深色画布会把文字压到 1.1:1 即看不见。
    // 与标签栏 / 窗格头 / 状态栏同一套 chrome 语言，也让深色主题自动成立。
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-xs">
      <Icon name="history" size={13} className="shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span className="font-medium text-foreground">{restored.length} 个上次会话待恢复</span>
        <span className="mx-1.5">·</span>
        连上后自动替换占位
      </span>
      <button
        type="button"
        disabled={running}
        onClick={() => void handleAll()}
        className="ml-auto shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? `恢复中 ${Math.min(progress.done + 1, progress.total)}/${progress.total}` : "全部恢复"}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title="本次忽略"
        aria-label="本次忽略"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
