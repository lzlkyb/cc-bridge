import type { RefObject, ComponentProps } from "react";
import type { useCcSession } from "../../hooks/useCcSession";
import type { CcPermissionMode } from "../../lib/ccGuiTypes";
import { contextBar } from "../../lib/ccContextUsage";
import { Composer } from "./Composer";
import { RunControls } from "./RunControls";
import { ContextMeter } from "./ContextMeter";
import { firstOffscreenApproval, useCcApprovalOffscreen } from "../../hooks/useCcApprovalOffscreen";

/** 将会话状态映射为输入区状态；输入与阅读两部分共享同一条真实会话。 */
export function CcPaneComposer({ session, scrollRef, model, mode, setModel, setMode, ...draft }: {
  session: ReturnType<typeof useCcSession>;
  scrollRef: RefObject<HTMLDivElement>;
  model: string;
  mode: CcPermissionMode;
  setModel: (value: string) => void;
  setMode: (value: CcPermissionMode) => void;
} & Pick<ComponentProps<typeof Composer>, "sendHint" | "onPolish" | "mentionSource" | "prefill" | "draftKey">) {
  const { view } = session;
  const approvalOffscreen = useCcApprovalOffscreen(scrollRef, session.pending.join("\u0000"));
  return <Composer {...draft}
    controls={<RunControls model={model} mode={mode} onModelChange={setModel} onModeChange={setMode} />}
    footer={<ContextMeter bar={contextBar(view.modelUsage)} tokens={view.inputTokens + view.outputTokens} sessionId={view.sessionId} running={view.running} />}
    queueItems={session.queue} onEditQueue={session.editQueue} onRemoveQueue={session.removeQueue} onMoveQueue={session.moveQueue}
    pendingCount={approvalOffscreen ? session.pending.length : 0} onShowPending={() => {
      const el = scrollRef.current ? firstOffscreenApproval(scrollRef.current) : undefined;
      const review = el?.querySelector<HTMLButtonElement>("[data-cc-approval-focus]");
      if (review) review.click();
      else { el?.scrollIntoView({ block: "center" }); el?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); }
    }}
    onSteer={session.steer} onSendNow={session.sendNow} inputs={view.inputs} onSend={session.start} running={view.running || session.busy || session.stopState === "stopping"} stopping={session.stopState === "stopping"}
    onInterrupt={() => void session.interrupt()}
    placeholder={session.pending.length > 0 ? "当前在等批准，可以补充要求；补充不会代替批准…" : view.running ? "补充要求，Clawd 会在工具完成后读取…" : "告诉 Clawd，@文件 /命令"}
    queueCount={session.queue.length} queuePaused={session.queuePaused}
    onClearQueue={session.clearQueue} onResumeQueue={session.resumeQueue}
  />;
}
