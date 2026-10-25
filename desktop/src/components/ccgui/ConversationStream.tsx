import type { RefObject } from "react";
import type { CcProbe } from "../../lib/ccEventTypes";
import type { CcView, } from "../../lib/ccReducer";
import { CcEmptyState } from "./CcEmptyState";
import { MessageList } from "./MessageList";

/**
 * 一个 pane 的中段：消息流（滚动容器 + 空状态 / 消息列表）。
 *
 * 从 `CcPane` 拆出（2026-10-25）。`scrollRef` 由 pane 持有并传下来：
 * 变更集面板的「跳到某条 diff」要拿它 `querySelector`，而滚动的时机
 * （有新内容就贴底）在 pane 的 effect 里 —— 两者共用同一个节点，拆不开。
 */
export function ConversationStream({
  scrollRef,
  view,
  probe,
  probing,
  retryProbe,
  onSend,
  onRespond,
  onForkMessage,
  cwd,
  onCwdChange,
  isRemote,
  newSessionHint,
}: {
  scrollRef: RefObject<HTMLDivElement>;
  view: CcView;
  probe: CcProbe | null;
  probing: boolean;
  retryProbe: () => void;
  onSend: (text: string) => void;
  onRespond: (
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
    answers?: Record<string, string[]>,
  ) => void;
  /** 编辑重发 / 从此处分叉（3-3）。见 `MessageList`。 */
  onForkMessage: (index: number, text: string) => void;
  cwd: string;
  onCwdChange: (v: string) => void;
  isRemote: boolean;
  newSessionHint: string;
}) {
  return (
    // page-scroll：对话流是长时停留的滚动区，要跟连接页/日志页同一根 12px rail，
    // 不挂就只有全局 6px 细条，右边缘看着比别的页窄一档。
    <div
      ref={scrollRef}
      data-cc-stream
      className="page-scroll min-h-0 flex-1 overflow-y-auto px-3 py-1"
    >
      <div className="mx-auto flex min-h-full max-w-[820px] flex-col gap-1.5">
        {view.messages.length === 0 ? (
          <CcEmptyState
            probe={probe}
            probing={probing}
            onRetryProbe={retryProbe}
            onSend={onSend}
            cwd={cwd}
            onCwdChange={onCwdChange}
            isRemote={isRemote}
            newSessionHint={newSessionHint}
          />
        ) : (
          <MessageList
            messages={view.messages}
            resolved={view.resolved}
            running={view.running}
            onRespond={onRespond}
            onForkMessage={onForkMessage}
          />
        )}
      </div>
    </div>
  );
}
