import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { StatusResponse } from "../../lib/types";
import { useCcSession } from "../../hooks/useCcSession";
import { useCcProbe } from "../../hooks/useCcProbe";
import { useCcPanePrefs } from "../../hooks/useCcPanePrefs";
import { useCcForkSeedRun } from "../../hooks/useCcFork";
import { useCcPolish } from "../../hooks/useCcPolish";
import { useCcStreamScroll } from "../../hooks/useCcStreamScroll";
import { useCcTargets } from "../../hooks/useCcTargets";
import type { CcHistoryRow, CcRestoreReq } from "../../lib/ccEventTypes";
import type { CcForkSeed } from "../../lib/ccFork";
import type { CcPaneMeta } from "../../lib/ccPaneMeta";
import { shortcutLabel } from "../../lib/platform";
import { useCcPaneViewModel } from "../../hooks/useCcPaneViewModel";
import { ConversationEnvironment } from "../ccgui/ApprovalEnvironment";
import { CcPaneHead } from "../ccgui/CcPaneHead";
import "../ccgui/chatWorkspace.css";
import { CcPaneComposer } from "../ccgui/CcPaneComposer";
import { ConversationStream } from "../ccgui/ConversationStream";
import { CcConversationLayout } from "../ccgui/CcConversationLayout";

/**
 * 一条对话会话的完整界面：会话条/提示条 + 消息流 + 输入区。
 *
 * 2026-10-25 从 `CcGuiTab` 拆出（3-1b 多会话）：原来 Tab 本身就是「那一条会话」，
 * 多会话之后 Tab 变成**宿主**（侧栏 + 若干 pane），每条会话一个 pane 实例。
 *
 * ## 为什么是「一个 pane 一个 useCcSession」而不是「一个 reducer 管 N 条」
 *
 * 状态真正的家在 Rust（`CcSession`：进程、事件流水、resume id、待批单），
 * 前端这层只是渲染 —— 所以多开一条的代价是**多一个订阅 + 多一个 reducer**，
 * 而不是把 reducer 改造成 `Map<id, View>`（那会把凡断言「一次事件 → 一个 view」
 * 的测试全部改掉，收益只是省了几份小状态）。
 *
 * 副作用是「切走的那条继续收事件」—— 这正是我们要的：切回来时审批卡还在、
 * 流式正文是连续的，不需要重放。隐藏用 CSS（`hidden`），不卸载。
 *
 * 运行配置（目标 / 目录 / 模型 / 权限）在 `useCcPanePrefs`，这里只剩接线与三段布局。
 */
export function CcPane({
  paneKey,
  active,
  restore,
  conflict,
  titleOverride,
  onMeta,
  onNewSession,
  onForkSession,
  onNavigate,
  onToggleSidebar, sidebarExpanded, compact,
}: {
  onToggleSidebar?: () => void;
  sidebarExpanded?: boolean;
  compact?: boolean;
  paneKey: string;
  active: boolean;
  /**
   * 首次挂载时从库里载入哪一条（三态见 `CcRestoreReq`）。**只在创建那一刻有意义**：
   * 收进 ref 固化首帧值，之后宿主就算重新渲染也不会触发重订阅
   * （重订阅会清空事件游标与「这是恢复来的」状态）。
   */
  restore: CcRestoreReq;
  /** 同目录下正在跑的另一条会话标题（`conflictWith`）。`null` = 没有冲突。 */
  conflict: string | null;
  /**
   * 用户手写的标题（3-1d）。`undefined` = 没改过名，标题仍按首条消息现算。
   *
   * 两条来源合一：本窗口刚改的（宿主 `useCcSessionActions.titles`）、上次改过
   * 存进库里的（`restored.titleLocked`）。前者优先 —— 它就是最新的。
   */
  titleOverride?: string;
  /** 把侧栏要显示的元信息报上去。按引用判重，见 `useCcPaneList.report`。 */
  onMeta: (key: string, meta: CcPaneMeta) => void;
  /** 新建**另一条**会话（侧栏的 +、Ctrl+N、会话条的「新对话」都走它）。 */
  onNewSession: () => void;
  /** 从本 pane 的某条消息分叉出去（3-3）：宿主负责新开一条 pane。 */
  onForkSession: (seed: CcForkSeed) => void;
  onNavigate: (tab: string) => void;
}) {
  const {
    targetId,
    setTargetId,
    cwd,
    setCwdPersist,
    mode,
    setMode,
    model,
    setModel,
    applyRestore,
    applySeed,
    applyOpenedCwd,
  } = useCcPanePrefs();
  const [findRequest, setFindRequest] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 空状态示例 prompt 的预填（`nonce` 递增：同一句连点两次也要重填）。 */
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  /** 载入意图在 pane 生命周期内不会变，用 ref 固化 —— 见 props 注释。 */
  const restoreRef = useRef<CcRestoreReq>(restore);

  // 目标列表（本机 + 在用的 SSH 连接）。与宿主共用同一个 hook / 同一条缓存。
  const targets = useCcTargets();

  const session = useCcSession(
    {
      connectionId: targetId || null,
      cwd: cwd.trim() || null,
      // 留空由 hook 内部的探测结果补：远端必须用绝对路径执行，
      // 而路径只有 probe 拿得到（这里不该再探一次）。
      claudePath: null,
      model: model || null,
      permissionMode: mode,
    },
    restoreRef,
  );
  const { view, restored, reportError } = session;

  /** 快捷键标签的平台来源（Ctrl+N / ⌘N）。与 App 共用 ["status"] 缓存不发请求；取舍见 lib/platform.ts。 */
  const { data: platform } = useQuery<StatusResponse, Error, string | undefined>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    select: (s) => s.platform,
  });
  const newSessionHint = shortcutLabel(platform, "N");

  /** 恢复出来的会话连同它的目标一起还原（含那三条容易踩的规则，见 hook 注释）。 */
  useEffect(() => {
    if (restored) applyRestore(restored);
  }, [restored, applyRestore]);

  /**
   * 分叉出来的 pane：继承源会话的运行配置 + 自动重跑那句话。
   * 两步顺序与「为什么必须两步」见 `hooks/useCcFork.ts`。
   */
  const seed = restore.kind === "seed" ? restore.seed : null;
  useCcForkSeedRun({
    seed,
    ready: session.ready,
    isRemote: targetId !== "",
    probeFound: session.probe?.found ?? false,
    applySeed,
    start: session.start,
  });

  /** 打开一条历史会话，并把**目标**一起切到它那边（远端转录会被拒，见 hook）。 */
  const onOpenHistory = useCallback(
    (row: CcHistoryRow) => {
      void session.openHistory(row.sessionId, row.connectionId).then((res) => {
        if (res) applyOpenedCwd(res.cwd ?? "");
      });
    },
    [session, applyOpenedCwd],
  );

  // 进页面 / 换目标时探一次 + 手动重试。`runProbe` 是 useCallback 稳定的，不会反复触发。
  const { probing, retry: retryProbe } = useCcProbe(session.runProbe, targetId);

  /**
   * 润色草稿：一次性的 `claude -p`，结果只回输入框，不进对话流、不占上下文。
   * 失败返回 `null`（Composer 不动文本），原因转成对话流里的一条 notice。
   */
  const onPolish = useCcPolish({ connectionId: targetId, cwd, reportError });

  // 新内容贴底 + 跳到某条工具卡（两块共用同一个滚动节点，见 `useCcStreamScroll`）。
  const jumpTo = useCcStreamScroll(scrollRef, {
    active,
    messages: view.messages,
    resolved: view.resolved,
  });

  // 侧栏元信息 / 会话条 / 历史行号 / 分叉切点全在 `useCcPaneViewModel`（2026-11 外移，
  // 那个文件头注写明了三条容易踩的规则）。
  const { metaBase, onForkMessage, bar } = useCcPaneViewModel({
    paneKey,
    view,
    session,
    targetId,
    targets,
    cwd,
    model,
    mode,
    titleOverride,
    restore,
    onMeta,
    onForkSession,
  });

  return (
    <ConversationEnvironment.Provider value={{ label: bar.connection, cwd: bar.cwd, remote: Boolean(targetId) }}><div
      data-cc-panel
      className={`${active ? "flex" : "hidden"} cc-conversation-panel h-full min-h-0 flex-col overflow-hidden`}
    >
      <CcPaneHead
        onToggleSidebar={onToggleSidebar} sidebarExpanded={sidebarExpanded} compact={compact}
        onFind={() => setFindRequest((n) => n + 1)}
        connectionStatus={probing ? "检查连接中…" : session.probe?.found === false ? "环境不可用" : session.probe?.found ? "已连接" : undefined}
        unavailable={session.probe?.found === false} probing={probing} onRetry={retryProbe}
        onSettings={targetId ? () => onNavigate("connect") : undefined}
        bar={bar}
        view={view}
        title={metaBase.title}
        targets={targets}
        targetId={targetId}
        onTargetChange={setTargetId}
        onCwdChange={setCwdPersist}
        mode={mode}
        onModeChange={setMode}
        onModelChange={setModel}
        onSwitchTerminal={() => onNavigate("terminal")}
        onNewSession={onNewSession}
        newSessionHint={newSessionHint}
        conflict={conflict}
        onOpenHistory={onOpenHistory}
        onJumpTo={jumpTo}
        onDismissError={session.dismissError}
        onDismissStderr={session.clearStderr}
      />

      <CcConversationLayout><ConversationStream
        findRequest={findRequest} scrollRef={scrollRef}
        view={view}
        sending={session.busy} activityStartedAt={session.activityStartedAt} stopState={session.stopState} onStopTask={(taskId, stopToken) => invoke<string>("cc_stop_task", { sessionId: session.sessionIdRef.current, taskId, stopToken })}
        probe={session.probe}
        probing={probing}
        retryProbe={retryProbe}
        onPickPrompt={(text) => setPrefill((p) => ({ text, nonce: (p?.nonce ?? 0) + 1 }))}
        onRespond={(id, decision, reason, answers) =>
          void session.respond(id, decision, reason, answers)
        }
        onForkMessage={onForkMessage}
        // 原地重发不带图（原图不落盘，历史里只有缩略图），气泡上的 title 已说明。
        onResend={(text) => void session.start(text, [])}
        cwd={cwd}
        onCwdChange={setCwdPersist}
        isRemote={Boolean(targetId)}
        newSessionHint={newSessionHint}
      />

      <CcPaneComposer session={session} scrollRef={scrollRef} model={model} mode={mode}
        setModel={setModel} setMode={setMode} sendHint={shortcutLabel(platform, "Enter")}
        onPolish={onPolish}
        mentionSource={{ connectionId: targetId, cwd }}
        prefill={prefill}
        draftKey={paneKey}
      />
    </CcConversationLayout></div></ConversationEnvironment.Provider>
  );
}
