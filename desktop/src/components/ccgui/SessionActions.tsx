import { memo, useState } from "react";
import type { CcHistoryRow } from "../../lib/ccEventTypes";
import type { CcMessage, CcSession } from "../../lib/ccGuiTypes";
import { useCcApprovalAudit } from "../../hooks/useCcApprovalAudit";
import { useCcExport } from "../../hooks/useCcExport";
import { Icon } from "../ui/icon";
import { ApprovalAuditPanel } from "./ApprovalAuditPanel";
import { HistoryPanel } from "./HistoryPanel";

/**
 * 会话条右端的**动作区**：改动 / 导出 / 历史 / 新对话 / 终端。
 *
 * 从 `SessionBar` 拆出（2026-10-26）：那一条已经 309 行，而这一组与左边的
 * 「运行参数」（目标 / 目录 / 模型 / 上下文 / 权限）没有状态往来 —— 它们各自
 * 持着自己的浮层开关，只是恰好排在同一行里。拆开后 `SessionBar` 只管参数，
 * 这里只管动作与浮层。
 *
 * 开头的竖线留在这里而不是父组件：它是「参数 | 动作」的分界，跟着这一组走，
 * 将来动作增减时不会和参数区错位。
 */
function SessionActionsImpl({
  session,
  messages,
  resolved,
  title,
  modelLabel,
  newSessionHint,
  onOpenHistory,
  onJumpTo,
  onNewSession,
  onSwitchTerminal,
}: {
  session: CcSession;
  messages: CcMessage[];
  /** `requestId → 裁决`：审计面板要靠它把审批点分组。 */
  resolved: Record<string, { decision: "allow" | "deny"; auto?: boolean }>;
  title: string;
  /** 会话条上显示的模型名（导出用，与用户在那一行看到的一致）。 */
  modelLabel: string;
  newSessionHint: string;
  onOpenHistory: (row: CcHistoryRow) => void;
  onJumpTo: (messageId: string) => void;
  onNewSession: () => void;
  onSwitchTerminal: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changesetOpen, setChangesetOpen] = useState(false);
  // 批 4-2：审批点分组 + 撤销。只在面板打开时查审计（理由见 hook 头注释）。
  const audit = useCcApprovalAudit({
    messages,
    resolved,
    cwd: session.cwd,
    sessionId: session.sessionId,
    enabled: changesetOpen,
  });
  const { exportMarkdown, canExport } = useCcExport({
    messages,
    title,
    cwd: session.cwd,
    model: modelLabel,
  });

  return (
    <>
      {/* 🔴 一条竖线把「这一行在说什么」劈成两半：左边是**运行参数**（模型 / 上下文 /
          花费 / 权限，都是「这一轮怎么跑」），右边是**动作**（改动 / 导出 / 历史 /
          新对话 / 终端）。此前十来个元素等距平铺，读的人得逐个辨认才发现它们不是一类。 */}
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />

      {/* 变更集入口：没有改动就不占位（同分支 chip 的「未知不占位」）。
          带数字是因为「改了没有、改了几处」是这一行最值得知道的事。 */}
      {session.changeset.length > 0 && (
        <span className="relative flex shrink-0 items-center">
          <button
            type="button"
            data-cc-toggle="changeset"
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
            <ApprovalAuditPanel
              groups={audit.groups}
              stat={audit.stat}
              reverted={audit.reverted}
              busyKey={audit.busyKey}
              onRevertOne={(p, f) => void audit.revertOne(p, f)}
              onRevertGroup={(g) => void audit.revertGroup(g)}
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

      {/* 导出整段对话为 Markdown。只给图标 —— 这一行在 700px 窄窗下被挤爆过，
          带文字的按钮会再吃掉 40px。空会话不摆（没什么可导出）。 */}
      {canExport && (
        <button
          type="button"
          onClick={exportMarkdown}
          title="导出这段对话为 Markdown（复制到剪贴板）"
          aria-label="导出对话"
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Icon name="download" size={12} />
        </button>
      )}

      <span className="relative flex shrink-0 items-center">
        <button
          type="button"
          data-cc-toggle="history"
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
        title={`新对话（${newSessionHint}，新开一条空白会话；当前这条原样保留在侧栏）`}
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
    </>
  );
}

export const SessionActions = memo(SessionActionsImpl);
