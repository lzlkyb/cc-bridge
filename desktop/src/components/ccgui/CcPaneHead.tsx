import type { CcHistoryRow } from "../../lib/ccEventTypes";
import { PERMISSION_MODE_RISK, type CcPermissionMode, type CcSession } from "../../lib/ccGuiTypes";
import type { CcView } from "../../lib/ccReducer";
import { SessionBar } from "./SessionBar";
import { SessionNotices } from "./SessionNotices";

/**
 * 一个 pane 的顶段：会话条（目标 / 目录 / 模型 / 权限 / 用量 / 历史）+
 * 提示条（风险 / 重试 / 丢弃 / 错误 / 压缩 / 后台任务）。
 *
 * 从 `CcPane` 拆出（2026-10-25）：这一段与下面的消息流、输入区没有状态往来，
 * 只是把同一个 pane 的偏好与视图往下传，独立成组件后 pane 只剩「状态 + 三段布局」。
 */
export function CcPaneHead({
  bar,
  view,
  targets,
  targetId,
  onTargetChange,
  mode,
  onModeChange,
  onModelChange,
  onSwitchTerminal,
  onNewSession,
  newSessionHint,
  conflict,
  onOpenHistory,
  onJumpTo,
  onDismissError,
}: {
  bar: CcSession;
  view: CcView;
  targets: { id: string; label: string }[];
  targetId: string;
  onTargetChange: (id: string) => void;
  mode: CcPermissionMode;
  onModeChange: (mode: CcPermissionMode) => void;
  onModelChange: (model: string) => void;
  onSwitchTerminal: () => void;
  onNewSession: () => void;
  newSessionHint: string;
  /** 同目录下正在跑的另一条会话标题（`conflictWith`）。`null` = 没有冲突。 */
  conflict: string | null;
  onOpenHistory: (row: CcHistoryRow) => void;
  onJumpTo: (messageId: string) => void;
  onDismissError: () => void;
}) {
  const risk = PERMISSION_MODE_RISK[mode];
  // 只留最近两行：stderr 动辄几十行，全铺出来会把消息区挤到看不见。
  const lastStderr = view.stderr.slice(-2);
  return (
    <>
      <SessionBar
        session={bar}
        messages={view.messages}
        resolved={view.resolved}
        targets={targets}
        targetId={targetId}
        onTargetChange={onTargetChange}
        mode={mode}
        onModeChange={onModeChange}
        onModelChange={onModelChange}
        onSwitchTerminal={onSwitchTerminal}
        onNewSession={onNewSession}
        newSessionHint={newSessionHint}
        onOpenHistory={onOpenHistory}
        onJumpTo={onJumpTo}
      />
      {/* 🔴 打开历史后必须把**目标**一起切过去（见 pane 里的 `onOpenHistory`）：
          只灌消息不改 cwd，下一句会被 `cc_start` 判成「换了目录」→ 清 resume id
          → 打开的历史当场变成一条新会话，模型忘光前面且不报错。 */}
      <SessionNotices
        risk={risk}
        conflict={conflict}
        retry={view.retry}
        dropped={view.dropped}
        error={view.error}
        stderr={lastStderr}
        compacted={view.compactedTokens}
        background={view.backgroundTasks}
        onDismiss={onDismissError}
      />
    </>
  );
}
