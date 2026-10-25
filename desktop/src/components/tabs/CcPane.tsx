import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { SshConnectionList, StatusResponse } from "../../lib/types";
import { useCcSession } from "../../hooks/useCcSession";
import { useCcProbe } from "../../hooks/useCcProbe";
import { useCcPanePrefs } from "../../hooks/useCcPanePrefs";
import type { CcHistoryRow, CcRestoreReq } from "../../lib/ccEventTypes";
import { derivePaneMeta, type CcPaneMeta } from "../../lib/ccPaneMeta";
import { toBarSession } from "../../lib/ccSessionBar";
import { shortcutLabel } from "../../lib/platform";
import { CcPaneHead } from "../ccgui/CcPaneHead";
import { Composer } from "../ccgui/Composer";
import { ConversationStream } from "../ccgui/ConversationStream";

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
  onNavigate,
}: {
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
    applyOpenedCwd,
  } = useCcPanePrefs();
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 载入意图在 pane 生命周期内不会变，用 ref 固化 —— 见 props 注释。 */
  const restoreRef = useRef<CcRestoreReq>(restore);

  const { data } = useQuery<SshConnectionList, Error>({
    queryKey: ["sshConnections"],
    queryFn: () => invoke<SshConnectionList>("ssh_list_connections"),
  });
  const targets = useMemo(
    () => [
      { id: "", label: "本机" },
      ...(data?.connections ?? []).map((c) => ({ id: c.id, label: c.name || c.host })),
    ],
    [data?.connections],
  );

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

  /**
   * 快捷键标签的平台来源（Ctrl+N / ⌘N）。与 App 层共用 `["status"]` 缓存，
   * **不会多发请求**；取后端值而非嗅探 UA 的理由见 `lib/platform.ts`，首帧未返回时
   * 先显示 Ctrl（那里写明的取舍）。
   */
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

  /** 打开一条历史会话，并把**目标**一起切到它那边。 */
  const onOpenHistory = useCallback(
    (row: CcHistoryRow) => {
      void session.openHistory(row.sessionId).then((res) => {
        if (res) applyOpenedCwd(res.cwd ?? "");
      });
    },
    [session, applyOpenedCwd],
  );

  // 进页面 / 换目标时探一次 + 手动重试。`runProbe` 是 useCallback 稳定的，不会反复触发。
  const { probing, retry: retryProbe } = useCcProbe(session.runProbe, targetId);

  /**
   * 润色草稿（mods/prompt-polish）。
   *
   * 走独立的 `cc_polish` 命令而不是会话通道：它是一次性的 `claude -p`，
   * 结果只回给输入框，不进对话流、不占会话上下文。失败返回 `null`
   * （Composer 不动文本），原因转成对话流里的一条 notice。
   */
  const onPolish = useCallback(
    async (draft: string): Promise<string | null> => {
      try {
        return await invoke<string>("cc_polish", {
          req: {
            connectionId: targetId || null,
            cwd: cwd.trim() || null,
            draft,
          },
        });
      } catch (e) {
        reportError(`润色失败：${e}`);
        return null;
      }
    },
    [targetId, cwd, reportError],
  );

  // 新内容贴底。ref 稳定，不进依赖。
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [view.messages, view.resolved]);

  // 跳到流里第一处 diff：锚点是 ToolCard 根节点的 data-cc-tool。高亮复用设置页
  // 深链的 anchor-highlight（主题色脉冲 2s），不新造一套动效。
  const jumpTo = useCallback((messageId: string) => {
    const node = scrollRef.current?.querySelector<HTMLElement>(
      `[data-cc-tool="${CSS.escape(messageId)}"]`,
    );
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("anchor-highlight");
    window.setTimeout(() => node.classList.remove("anchor-highlight"), 2000);
  }, []);

  /**
   * 侧栏那一行：标题 / 轮数 / 五态点 / 副标题。纯计算在 `lib/ccPaneMeta`。
   *
   * `sessionId` 在 effect 里读 ref 而不是在 `useMemo` 里：内部 id 是**铸发后**
   * 才写进 ref 的，进来那一刻（甚至第一帧）还是 null。`ready` 从 false 变 true
   * 正好是「铸发 + 快照都走完」的那一刻，拿它当依赖才能把 id 补上。
   */
  const metaBase = useMemo(() => {
    const targetLabel = targets.find((t) => t.id === targetId)?.label ?? "本机";
    return derivePaneMeta({
      view,
      pending: session.pending,
      connectionId: targetId || null,
      targetLabel,
      targetAlive: targetId === "" || targets.some((t) => t.id === targetId),
      // 输入框里的目录（不是 `view.cwd`）：同目录并发判的是「按下发送会落到哪」。
      cwd,
      // 恢复没走完就别让历史区露出来 —— 那时本条还没有 rowId / cliSessionId，
      // 对不上账会让它自己在历史区里再出现一次（可点 ⇒ 开出重复的一条）。
      restoring: !session.ready,
      // 手写标题优先于「首条消息」：改完名看不到变化，等于改名没生效。
      titleHint: titleOverride ?? (session.restored?.titleLocked ? session.restored.title : null),
    });
  }, [view, session.pending, targetId, targets, cwd, session.ready, titleOverride, session.restored]);
  /**
   * 库里那一行的行号，给侧栏历史区对账用。
   *
   * 两个来源：「从历史打开」的 entry 自带（不用等后端）；「接着上次聊」的
   * 要等 `cc_restore` 返回。新会话是 `null`（一句话没说，还没落盘）。
   *
   * 有它，历史区在恢复完成的那一刻就能把这条摘掉 —— 只靠 `view.sessionId`
   * 会慢几百毫秒（`Init` 事件才带），那段时间用户能点出重复的一条。
   */
  const rowId = restore.kind === "row" ? restore.rowId : (session.restored?.rowId ?? null);
  useEffect(() => {
    onMeta(paneKey, { ...metaBase, sessionId: session.sessionIdRef.current, rowId });
  }, [paneKey, metaBase, session.ready, session.sessionIdRef, onMeta, rowId]);

  const bar = useMemo(
    () =>
      toBarSession({
        connectionLabel: targets.find((t) => t.id === targetId)?.label ?? "本机",
        cwd,
        model,
        permissionMode: mode,
        view,
      }),
    [targets, targetId, cwd, model, mode, view],
  );

  return (
    <div
      data-cc-panel
      className={`${active ? "flex" : "hidden"} h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-card`}
    >
      <CcPaneHead
        bar={bar}
        view={view}
        targets={targets}
        targetId={targetId}
        onTargetChange={setTargetId}
        mode={mode}
        onModeChange={setMode}
        onModelChange={setModel}
        onSwitchTerminal={() => onNavigate("terminal")}
        onNewSession={onNewSession}
        newSessionHint={newSessionHint}
        conflict={conflict}
        onOpenHistory={onOpenHistory}
        onJumpTo={jumpTo}
        onDismissError={session.clearError}
      />

      <ConversationStream
        scrollRef={scrollRef}
        view={view}
        probe={session.probe}
        probing={probing}
        retryProbe={retryProbe}
        onSend={session.start}
        onRespond={(id, decision, reason, answers) =>
          void session.respond(id, decision, reason, answers)
        }
        cwd={cwd}
        onCwdChange={setCwdPersist}
        isRemote={Boolean(targetId)}
        newSessionHint={newSessionHint}
      />

      <Composer
        onSend={session.start}
        running={view.running || session.busy}
        onInterrupt={() => void session.interrupt()}
        placeholder={session.pending.length > 0 ? "先处理上面的审批，再继续…" : "给 CC 发消息…"}
        queueCount={session.queue.length}
        onClearQueue={session.clearQueue}
        onPolish={onPolish}
      />
    </div>
  );
}
