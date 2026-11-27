import type { ComponentProps } from "react";
import type { useCcSession } from "../../hooks/useCcSession";
import type { CcPermissionMode } from "../../lib/ccGuiTypes";
import { contextBar } from "../../lib/ccContextUsage";
import { Composer } from "./Composer";
import { RunControls } from "./RunControls";
import { ContextMeter } from "./ContextMeter";
import { PendingRequests } from "./PendingRequests";

/** 将会话状态映射为输入区状态；输入与阅读两部分共享同一条真实会话。 */
export function CcPaneComposer({ session, model, mode, setModel, setMode, loadingSession, ...draft }: {
  session: ReturnType<typeof useCcSession>;
  model: string;
  mode: CcPermissionMode;
  setModel: (value: string) => void;
  setMode: (value: CcPermissionMode) => void;
  loadingSession?: boolean;
} & Pick<ComponentProps<typeof Composer>, "sendHint" | "onPolish" | "mentionSource" | "prefill" | "draftKey" | "onUnsentChange">) {
  const { view } = session;
  return <Composer {...draft}
    controls={<RunControls model={model} mode={mode} activeModel={view.model} activeSettings={session.activeSettings} onModelChange={setModel} onModeChange={setMode} />}
    footer={<ContextMeter bar={contextBar(view.modelUsage)} tokens={view.inputTokens + view.outputTokens} sessionId={view.sessionId} running={view.running} />}
    queueItems={session.queue} onEditQueue={session.editQueue} onRemoveQueue={session.removeQueue} onMoveQueue={session.moveQueue}
    pendingRequests={<PendingRequests />}
    onSteer={session.steer} onSendNow={session.sendNow} inputs={view.inputs} onSend={loadingSession ? () => false : session.start} sendBlocked={loadingSession} running={view.running || session.busy || session.stopState === "stopping"} stopping={session.stopState === "stopping"}
    onInterrupt={() => void session.interrupt()}
    placeholder={loadingSession ? (session.loadFailed ? "会话加载失败" : "正在打开会话…") : session.pending.length > 0 ? "当前在等批准，可以补充要求；补充不会代替批准…" : view.running ? "补充要求，Clawd 会在工具完成后读取…" : "告诉 Clawd，@文件 /命令"}
    queueCount={session.queue.length} queuePaused={session.queuePaused}
    onClearQueue={session.clearQueue} onResumeQueue={session.resumeQueue}
  />;
}
