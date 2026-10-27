import { memo, useRef, useState } from "react";
import { PERMISSION_MODE_LABEL, type CcPermissionMode, type CcSession } from "../../lib/ccGuiTypes";
import type { CcMessage } from "../../lib/ccGuiTypes";
import { contextBar } from "../../lib/ccContextUsage";
import type { CcHistoryRow } from "../../lib/ccEventTypes";
import { Icon, type IconName } from "../ui/icon";
import { ContextMeter } from "./ContextMeter";
import { CwdChip } from "./CwdChip";
import { ModelPicker } from "./ModelPicker";
import { SessionActions } from "./SessionActions";

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
 *
 * ## 这一行现在是「参数 | 动作」两段
 *
 * 本组件只管**运行参数**（目标 / 目录 / 分支 / 模型 / 上下文 / 花费 / 权限），
 * 右端的**动作**（改动 / 导出 / 历史 / 新对话 / 终端）连同它们的浮层在
 * `SessionActions` 里 —— 两者没有状态往来，只是排在同一行。
 */
function SessionBarImpl({
  session,
  messages,
  resolved,
  title,
  targets,
  targetId,
  onTargetChange,
  mode,
  onModeChange,
  onModelChange,
  onCwdChange,
  isRemote,
  onSwitchTerminal,
  onNewSession,
  newSessionHint,
  onOpenHistory,
  onJumpTo,
}: {
  session: CcSession;
  /** 会话流水：动作区那边要靠它分组审批点、拼导出正文。 */
  messages: CcMessage[];
  /** `requestId → 裁决`：审批点显示「允许 / 拒绝 / 自动放行」靠它。 */
  resolved: Record<string, { decision: "allow" | "deny"; auto?: boolean }>;
  /** 会话标题（导出 Markdown 的 H1）。与侧栏那一行同源，由 `CcPane` 现算后传下来。 */
  title: string;
  targets: { id: string; label: string }[];
  targetId: string;
  onTargetChange: (id: string) => void;
  mode: CcPermissionMode;
  onModeChange: (mode: CcPermissionMode) => void;
  /** 换下一轮的模型。空串 = 跟随 CLI 默认。 */
  onModelChange: (model: string) => void;
  /** 换工作目录（下一轮生效；说过话的会话会另起一条）。 */
  onCwdChange: (cwd: string) => void;
  /** 远端目标：目录选择器不提供本机「浏览」。 */
  isRemote: boolean;
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
  const [modelOpen, setModelOpen] = useState(false);
  // 浮层的定位锚点。必须挂在**按钮容器**上：浮层按它的 rect 算 fixed 坐标，
  // 用 `absolute` 会随会话条换行被 pane 的左边界裁掉（见 useAnchoredPopover）。
  const modelAnchor = useRef<HTMLSpanElement>(null);
  // 显示优先级：我们的选择 > CLI 回报的当前模型 > 占位。
  // 只用 CLI 回报值会让「选了默认」和「没选过」看起来一模一样。
  const modelLabel = session.model || session.activeModel || "默认模型";

  return (
    // `relative` 是历史面板的定位锚点：面板必须浮在消息区上方而**不占布局**，
    // 占高度会让消息区在打开的瞬间收缩、正在读的位置跟着跳。
    <div
      data-cc-rule
      // flex-wrap：窗口缩到最小宽度（560px）时右端一组按钮约需 650px，不换行就会被 pane 的
      // overflow-hidden 裁掉（「历史 / 新对话 / 终端」看不见也点不到）。
      className="relative flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2"
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
      <CwdChip
        cwd={session.cwd}
        isRemote={isRemote}
        hasMessages={messages.some((m) => m.kind === "user")}
        onChange={onCwdChange}
      />
      {/* 分支未知时不占位：空白 chip 比没有 chip 更像 bug。 */}
      {session.branch && <Chip icon="gitBranch">{session.branch}</Chip>}

      {/* max-w-full + flex-wrap：这一组自己也比容器宽时在组内换行，而不是撑破容器。 */}
      <span className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
        <span ref={modelAnchor} className="relative flex items-center">
          <button
            type="button"
            data-cc-toggle="model"
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
              anchorRef={modelAnchor}
            />
          )}
        </span>
        {/* 上下文计量表（余量条 + 构成面板入口）：批 4-1。独立成组件是因为
            这一行已经贴到体量门禁，而它与会话条其余部分没有状态往来。 */}
        <ContextMeter bar={bar} tokens={tokens} sessionId={session.sessionId} running={session.running} />
        {/* 没花钱的会话不占位 —— 与分支 chip 的「未知不占位」同一条规矩：
            一排 `$0.00` 只是噪音，而它恰好是最容易被误读成「已经计费了」的那种噪音。 */}
        {session.costUsd > 0 && (
          <span className="font-mono text-[11px] text-muted-foreground">
            ${session.costUsd.toFixed(2)}
          </span>
        )}
      </span>

      {/* 开关与动作单独一组（也 `ml-auto`）：整组挤在一个 `ml-auto` 里时，组内
          换行会把「模型…权限」和「动作」都堆到右端，于是第一行只剩目标与目录、
          右半截全空（1578px 窗口下实测空出约 800px）。拆成两组后 flex 先在第一行
          放参数、放不下才让动作整体落到第二行，两行都贴右端且第一行不再大段留白。 */}
      <span className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
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

        <SessionActions
          session={session}
          messages={messages}
          resolved={resolved}
          title={title}
          modelLabel={modelLabel}
          newSessionHint={newSessionHint}
          onOpenHistory={onOpenHistory}
          onJumpTo={onJumpTo}
          onNewSession={onNewSession}
          onSwitchTerminal={onSwitchTerminal}
        />
      </span>
    </div>
  );
}

export const SessionBar = memo(SessionBarImpl);
