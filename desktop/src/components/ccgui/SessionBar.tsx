import { memo, useState } from "react";
import { PERMISSION_MODE_LABEL, type CcPermissionMode, type CcSession } from "../../lib/ccGuiTypes";
import { contextBar } from "../../lib/ccContextUsage";
import type { CcHistoryRow } from "../../lib/ccEventTypes";
import { Icon, type IconName } from "../ui/icon";
import { ChangesetPanel } from "./ChangesetPanel";
import { ContextMeter } from "./ContextMeter";
import { HistoryPanel } from "./HistoryPanel";
import { ModelPicker } from "./ModelPicker";

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
  onModelChange,
  onSwitchTerminal,
  onNewSession,
  newSessionHint,
  onOpenHistory,
  onJumpTo,
}: {
  session: CcSession;
  targets: { id: string; label: string }[];
  targetId: string;
  onTargetChange: (id: string) => void;
  mode: CcPermissionMode;
  onModeChange: (mode: CcPermissionMode) => void;
  /** 换下一轮的模型。空串 = 跟随 CLI 默认。 */
  onModelChange: (model: string) => void;
  onSwitchTerminal: () => void;
  onNewSession: () => void;
  /** 新对话的快捷键标签（`Ctrl+N` / `⌘N`）。由 CcGuiTab 从 status 里取平台后拼好传下。 */
  newSessionHint: string;
  /** 打开一条历史会话。由 `CcGuiTab` 负责切目标、改目录、灌消息。 */
  onOpenHistory: (row: CcHistoryRow) => void;
  /** 跳到流里某条工具消息（变更集面板的点名跳转，滚动 + 高亮在 CcGuiTab）。 */
  onJumpTo: (messageId: string) => void;
}) {
  const tokens = session.inputTokens + session.outputTokens;
  // 上下文余量条：CLI 每轮在 `result.modelUsage` 里给累计值与窗口。没有窗口
  // （老流水 / 老版本 CLI）时 bar 为 null，退回只显示已用 token 的旧形态。
  const bar = contextBar(session.modelUsage);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [changesetOpen, setChangesetOpen] = useState(false);
  // 显示优先级：我们的选择 > CLI 回报的当前模型 > 占位。
  // 只用 CLI 回报值会让「选了默认」和「没选过」看起来一模一样。
  const modelLabel = session.model || session.activeModel || "默认模型";

  return (
    // `relative` 是历史面板的定位锚点：面板必须浮在消息区上方而**不占布局**，
    // 占高度会让消息区在打开的瞬间收缩、正在读的位置跟着跳。
    <div
      data-cc-rule
      className="relative flex shrink-0 items-center gap-3 border-b border-border px-3 py-2"
    >
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
        <span className="relative flex items-center">
          <button
            type="button"
            onClick={() => setModelOpen((v) => !v)}
            aria-expanded={modelOpen}
            title="选择模型（下一轮生效）"
            className="flex items-center gap-1 rounded-md px-1 py-[2px] text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <Icon name="sparkles" size={11} className="shrink-0 opacity-70" />
            <span className="max-w-[132px] truncate font-mono">{modelLabel}</span>
            <Icon name="chevronDown" size={10} className="shrink-0 opacity-60" />
          </button>
          {modelOpen && (
            <ModelPicker
              value={session.model}
              onChange={onModelChange}
              onClose={() => setModelOpen(false)}
            />
          )}
        </span>
        {/* 上下文计量表（余量条 + 构成面板入口）：批 4-1。独立成组件是因为
            这一行已经贴到体量门禁，而它与会话条其余部分没有状态往来。 */}
        <ContextMeter bar={bar} tokens={tokens} sessionId={session.sessionId} running={session.running} />
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

        {/* 变更集入口：没有改动就不占位（同分支 chip 的「未知不占位」）。
            带数字是因为「改了没有、改了几处」是这一行最值得知道的事。 */}
        {session.changeset.length > 0 && (
          <span className="relative flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => setChangesetOpen((v) => !v)}
              aria-expanded={changesetOpen}
              title={`本会话改动：${session.changeset.length} 个文件`}
              aria-label="本会话改动"
              className={`flex h-[26px] items-center gap-1 rounded-lg border px-1.5 text-[11px] transition-colors ${
                changesetOpen
                  ? "border-primary/40 text-foreground"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
              }`}
            >
              <Icon name="file" size={12} />
              <span className="font-mono">{session.changeset.length}</span>
            </button>
            {changesetOpen && (
              <ChangesetPanel
                entries={session.changeset}
                onJump={(id) => {
                  // 跳完即关：浮层盖着消息区，用户看不见自己跳到了哪儿。
                  setChangesetOpen(false);
                  onJumpTo(id);
                }}
                onClose={() => setChangesetOpen(false)}
              />
            )}
          </span>
        )}

        {/* 只给图标：这一行在 700px 窄窗下已经被挤爆过（cwd 截成 `p...`），
            任何带文字的按钮都会再吃掉 40px。 */}
        <span className="relative flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
            title="历史对话（本机 Claude Code 的全部转录，包括终端页里聊的）"
            aria-label="历史对话"
            className={`flex h-[26px] w-[26px] items-center justify-center rounded-lg border transition-colors ${
              historyOpen
                ? "border-primary/40 text-foreground"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
          >
            <Icon name="history" size={12} />
          </button>
          {historyOpen && (
            <HistoryPanel
              onClose={() => setHistoryOpen(false)}
              onOpen={(row) => {
                setHistoryOpen(false);
                onOpenHistory(row);
              }}
            />
          )}
        </span>

        <button
          type="button"
          onClick={onNewSession}
          title={`新对话（${newSessionHint}，清空这条会话链，CC 不再记得上面的事）`}
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
