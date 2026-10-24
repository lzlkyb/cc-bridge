import { memo } from "react";
import { PERMISSION_MODE_LABEL, type CcPermissionMode, type CcSession } from "../../lib/ccGuiTypes";
import { Icon, type IconName } from "../ui/icon";

const MODES: CcPermissionMode[] = ["plan", "default", "acceptEdits", "bypassPermissions"];

function Chip({ icon, children, title }: { icon: IconName; children: React.ReactNode; title?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" title={title}>
      <Icon name={icon} size={11} className="shrink-0 opacity-70" />
      <span className="truncate font-mono">{children}</span>
    </span>
  );
}

/**
 * 会话条：把「我在连哪、在哪个目录、花了多少」压成一行。
 *
 * 右端保留「切回终端」——CC GUI 是并列视图，绝不是终端的替代品：
 * vi / htop / tmux / 构建日志只能进终端。这个入口消失，功能就变成了陷阱。
 *
 * 左端的连接名现在是个下拉：本机 / 某台 SSH（`id === ""` 表示本机）。
 * 用原生 `<select>` 而不是自绘菜单 —— 这一行里它只是「切换目标」，
 * 不值得为它引入一层弹层与焦点管理。
 */
function SessionBarImpl({
  session,
  targets,
  targetId,
  onTargetChange,
  mode,
  onModeChange,
  onSwitchTerminal,
  onNewSession,
}: {
  session: CcSession;
  targets: { id: string; label: string }[];
  targetId: string;
  onTargetChange: (id: string) => void;
  mode: CcPermissionMode;
  onModeChange: (mode: CcPermissionMode) => void;
  onSwitchTerminal: () => void;
  onNewSession: () => void;
}) {
  const tokens = session.inputTokens + session.outputTokens;

  return (
    <div data-cc-rule className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2">
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className={`h-[6px] w-[6px] rounded-full ${session.running ? "bg-success" : "bg-muted-foreground/50"}`}
        />
        <select
          aria-label="对话运行在哪"
          value={targetId}
          onChange={(e) => onTargetChange(e.target.value)}
          className="max-w-[132px] cursor-pointer truncate border-0 bg-transparent p-0 text-[12px] font-semibold text-foreground outline-none"
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </span>
      <Chip icon="folder" title={session.cwd || "继承 claude 的当前目录"}>
        {session.cwd || "默认目录"}
      </Chip>
      {/* 分支未知时不占位：空白 chip 比没有 chip 更像 bug。 */}
      {session.branch && <Chip icon="gitBranch">{session.branch}</Chip>}

      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Icon name="sparkles" size={11} className="shrink-0 opacity-70" />
          <span className="font-mono">{session.model}</span>
        </span>
        <span className="font-mono text-[11px] text-muted-foreground" title="输入 + 输出 token">
          {(tokens / 1000).toFixed(1)}K
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">${session.costUsd.toFixed(2)}</span>

        <span data-cc-seg className="flex items-center gap-px rounded-lg border border-border bg-muted/50 p-[2px]">
          {MODES.map((m) => {
            const on = m === mode;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                onClick={() => onModeChange(m)}
                className={`rounded-[6px] px-[7px] py-[2px] text-[11px] font-medium transition-colors ${
                  on
                    ? "bg-card text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {PERMISSION_MODE_LABEL[m]}
              </button>
            );
          })}
        </span>

        {/* 只给图标：这一行在 700px 窄窗下已经被挤爆过（cwd 截成 `p...`），
            任何带文字的按钮都会再吃掉 40px。 */}
        <button
          type="button"
          onClick={onNewSession}
          title="新对话（清空这条会话链，CC 不再记得上面的事）"
          aria-label="新对话"
          className="flex h-[26px] w-[26px] items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Icon name="plus" size={12} />
        </button>

        <button
          type="button"
          onClick={onSwitchTerminal}
          title="切回终端（原终端页不受影响）"
          className="flex h-[26px] items-center gap-1 rounded-lg border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Icon name="terminal" size={12} />
          终端
        </button>
      </span>
    </div>
  );
}

export const SessionBar = memo(SessionBarImpl);
