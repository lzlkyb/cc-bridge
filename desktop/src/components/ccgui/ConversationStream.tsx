import { useCallback, useMemo, useRef, type CSSProperties, type RefObject } from "react";
import type { CcProbe } from "../../lib/ccEventTypes";
import { pendingApprovals, type CcView } from "../../lib/ccReducer";
import { CHAT_TYPOGRAPHY, useChatTypography } from "../../lib/chatTypography";
import { useAnnouncer } from "../../hooks/useAnnouncer";
import { useCcConvSearch } from "../../hooks/useCcConvSearch";
import { useCcMessageNav } from "../../hooks/useCcMessageNav";
import { useCcScrollAway } from "../../hooks/useCcScrollAway";
import { useCcFindReveal } from "../../hooks/useCcFindReveal";
import { useMessageWindow } from "../../hooks/useMessageWindow";
import { CcEmptyState } from "./CcEmptyState";
import { CcFindBar } from "./CcFindBar";
import { MessageList } from "./MessageList";
import { StreamHud } from "./StreamHud";
import { SelectionQuote } from "./SelectionQuote";
import { clawdActivity } from "../../lib/ccClawd";
import { ClawdWorkspace } from "./ClawdWorkspace";
import type { StopTask } from "../../hooks/useClawdTaskStop";

/**
 * 一个 pane 的中段：消息流（滚动容器 + 空状态 / 消息列表）+ 会话内搜索。
 *
 * 从 `CcPane` 拆出（2026-10-25）。`scrollRef` 由 pane 持有并传下来：
 * 变更集面板的「跳到某条 diff」要拿它 `querySelector`，而滚动的时机
 * （有新内容就贴底）在 pane 的 effect 里 —— 两者共用同一个节点，拆不开。
 *
 * 会话内搜索（Ctrl+F）挂在这里而不是 pane：每个 pane 一份，互不串扰；
 * pane 本体已顶到体量门限，也不该再长。
 */
export function ConversationStream({
  scrollRef,
  findRequest = 0,
  view,
  sending = false,
  activityStartedAt = null,
  stopState = null,
  onStopTask,
  probe,
  probing,
  retryProbe,
  onPickPrompt,
  onRespond,
  onForkMessage,
  onResend,
  cwd,
  onCwdChange,
  isRemote,
  newSessionHint,
}: {
  findRequest?: number;
  scrollRef: RefObject<HTMLDivElement>;
  view: CcView;
  sending?: boolean;
  activityStartedAt?: number | null;
  stopState?: "stopping" | "unconfirmed" | null;
  onStopTask?: StopTask;
  probe: CcProbe | null;
  probing: boolean;
  retryProbe: () => void;
  /** 空状态里点示例 prompt：填进输入框（不直接发送）。 */
  onPickPrompt: (text: string) => void;
  onRespond: (
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
    answers?: Record<string, string[]>,
  ) => void;
  /** 编辑重发 / 从此处分叉（3-3）。见 `MessageList`。 */
  onForkMessage: (index: number, text: string) => void;
  /** 在原地重发最后一条用户消息。见 `MessageList`。 */
  onResend: (text: string) => void;
  cwd: string;
  onCwdChange: (v: string) => void;
  isRemote: boolean;
  newSessionHint: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const activity = useMemo(() => clawdActivity(view, { sending, stopState }), [view, sending, stopState]);
  const search = useCcConvSearch(view.messages);
  const { hits, occ } = search;
  const { away, toBottom } = useCcScrollAway(scrollRef);
  /** 按轮导航（在「我的提问」之间跳）。读布局定位，见 hook 头注释。 */
  const nav = useCcMessageNav(scrollRef);
  /**
   * 长会话渲染窗口（P0-5）：首屏只画最近 200 条。
   *
   * 状态放在这里而不是 `MessageList`：「加载更早」要记住旧 `scrollHeight` 并在下一帧
   * 补 `scrollTop`，只有拿着 `scrollRef` 的地方做得到。
   * `sessionKey` 用记录 id：切会话时窗口复位，否则在一条长会话里翻到全量之后，
   * 换一条会话会直接全量渲染。
   */
  const win = useMessageWindow(view.messages.length, `${view.rowId ?? ""}:${view.sessionId ?? ""}`);
  const loadEarlier = useCallback(() => {
    const el = scrollRef.current;
    const before = el?.scrollHeight ?? 0;
    const top = el?.scrollTop ?? 0;
    win.loadEarlier();
    // 🔴 必须在 rAF 里补：此刻 DOM 还是旧高度，同步读到的 scrollHeight 没有变化。
    requestAnimationFrame(() => {
      if (!el) return;
      el.scrollTop = top + (el.scrollHeight - before);
    });
  }, [scrollRef, win]);
  // 流式输出时 view 每个 tick 都变，但待批准数只随消息列表 / 裁决表变，用 memo 避免每次都全量遍历。
  const pendingCount = useMemo(
    () => pendingApprovals({ messages: view.messages, resolved: view.resolved }).length,
    [view.messages, view.resolved],
  );
  /**
   * 读屏播报：只出四条（开始 / 阶段 / 完成 / 失败），见 `lib/ccAnnounce.ts`。
   *
   * 与下面滚动容器上的 `aria-live` 分工：容器负责「转录区本身可读、可导航」，
   * 播报区负责「一句话说清现在发生什么」。两者都不逐 token 出声 —— 容器靠
   * `aria-busy`（轮次进行中把播报压到结束），播报区靠 id 去重 + 最小间隔。
   */
  const announce = useAnnouncer(view, pendingCount);
  // 正文排版偏好（设计稿《对话页-@引用与排版偏好》C 期）：CSS 变量挂在本容器，
  // MarkdownText 消费 —— 不穿 props 链，所有 pane 同时生效。
  const typo = useChatTypography();
  const typoStyle = {
    "--cc-chat-fs": CHAT_TYPOGRAPHY[typo].px,
    "--cc-chat-lh": CHAT_TYPOGRAPHY[typo].lh,
  } as CSSProperties;

  // 搜索的三段副作用（唤起 / 命中滚进视口 / 命中在窗口外时扩窗）都在这个 hook 里，
  // 连同那两条「不跟着 hits 引用走」「只让可见 pane 响应」的讲究。
  useCcFindReveal({ scrollRef, findRequest, search, expandAll: win.expandAll });

  const closeSearch = useCallback(() => {
    search.close();
    // 焦点还给输入区（设计稿）：经由 pane 根节点找 textarea，不开新的 props 通道。
    scrollRef.current
      ?.closest("[data-cc-panel]")
      ?.querySelector<HTMLTextAreaElement>("textarea")
      ?.focus();
  }, [search, scrollRef]);

  return (
    // 外层只做定位锚（搜索条浮在滚动区之上，不随内容滚动）；
    // page-scroll：对话流是长时停留的滚动区，要跟连接页/日志页同一根 12px rail，
    // 不挂就只有全局 6px 细条，右边缘看着比别的页窄一档。
    <div ref={rootRef} className="cc-clawd-stream relative min-h-0 flex-1" style={typoStyle}>
      {/*
        🔴 底部浮条相对**这一层**定位，不相对外层：外层底下还坐着 Clawd dock，
        相对外层就得靠 `--clawd-dock-height` 把浮条顶上去，而那个值是 JS 每帧
        写的、首帧回退值必然对不上（dock 实测闲态约 51px / 忙态约 55px，JS 里写死的
        回退值是 72px）⇒ 打开会话时浮条先浮高约 20px 再落下来。多包一层 flex 容器，
        浮条贴它的底就永远贴着 dock 的顶，也不再依赖另一个组件的副作用。
      */}
      <div className="cc-stream-viewport relative flex min-h-0 flex-1">
        {/*
          转录区的无障碍语义（P0-1）：
          - `role="log"`：这是「追加型日志」，读屏可以按消息跳读。
          - `aria-live="polite"` + `aria-relevant="additions"`：只念**新插入**的节点。
            流式是改写已有节点，带上 `text` 会让每个碎片都被念一遍。
          - `aria-busy`：一轮进行中把播报压住，结束时一次性放行 —— 这是「不逐 token
            播报」最省事的实现，不用自己写节流。
            ⚠️ 代价是某些读屏会在放行那一刻把本轮新增内容整段念出来。真机（NVDA）
            验收若确认太吵，把 `aria-live` 改成 `off`、只留独立播报区即可 —— 一行回退，
            语义（role=log）和导航能力都不受影响。
        */}
        <div
          ref={scrollRef}
          data-cc-stream
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-busy={view.running || sending}
          aria-label="对话记录"
          className="cc-conversation-stream page-scroll h-full w-full overflow-y-auto"
        >
          {/* cc-msgcol：消息列。子节点（每条消息的根元素）离屏跳渲染，见 index.css。 */}
          <div className="cc-msgcol mx-auto flex min-h-full max-w-[834px] flex-col gap-3">
            {view.messages.length === 0 && !view.running && !sending && view.stops.length === 0 ? (
              <CcEmptyState
                probe={probe}
                probing={probing}
                onRetryProbe={retryProbe}
                onPickPrompt={onPickPrompt}
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
                marksByMsg={search.marksByMsg}
                turns={view.turns}
                stops={view.stops}
                stopState={stopState}
                companionTarget={activity.targetId}
                onRespond={onRespond}
                onForkMessage={onForkMessage}
                onResend={onResend}
                startIndex={win.start}
                onLoadEarlier={loadEarlier}
              />
            )}
          </div>
        </div>
        {away && view.messages.length > 0 && (
          // 一条浮条：「按轮导航」+「回到底部」。
          //
          // 🔴 用 `inset-x-0 + justify-center` 居中，**不用** `left-1/2 + -translate-x-1/2`：
          //    后者是绝对定位的 shrink-to-fit，可用宽度只等于**容器的一半**（left 已经吃掉
          //    一半），窄 pane 下「有 N 条待批准 · 回到底部」会被压成两行、在固定的 32px
          //    高度里溢出。实测 420px 宽就复现。
          // 外层 `pointer-events-none` + 两个按钮自己 `pointer-events-auto`：这一行横跨
          // 整个消息区底部，不放开穿透就会挡住底下的正文点击。
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex items-center justify-center gap-2 px-3">
            <StreamHud
              messages={view.messages}
              startIndex={view.activityStartIndex}
              resolved={view.resolved}
              running={view.running}
              sending={sending}
              retry={view.retry}
              stopState={stopState}
              pending={activity.pose === "approval" || activity.pose === "question" ? 0 : pendingCount}
              onPrev={nav.prev}
              onNext={nav.next}
              onBottom={toBottom}
            />
          </div>
        )}
      </div>
      <ClawdWorkspace view={view} activity={activity} rootRef={rootRef} scrollRef={scrollRef} startedAt={activityStartedAt} onStopTask={onStopTask} />
      {/*
        播报区：**不挂在 log 内部** —— 挂在里面就成了「日志新增一条」，会被容器
        自己的 `aria-busy` 一起压住（那就永远不播了）。
        两个节点分列 polite / assertive：`role="alert"` 自带 assertive，只给失败用；
        `key={seq}` 让同一句文案重复出现时也换节点，读屏才会再念一次。
      */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce && announce.level === "polite" ? <span key={announce.seq}>{announce.text}</span> : null}
      </div>
      <div className="sr-only" role="alert" aria-atomic="true">
        {announce && announce.level === "assertive" ? <span key={announce.seq}>{announce.text}</span> : null}
      </div>
      <SelectionQuote scrollRef={scrollRef} />
      {search.open && (
        <CcFindBar
          query={search.query}
          onQuery={search.changeQuery}
          occ={occ}
          total={hits.length}
          onNext={search.next}
          onPrev={search.prev}
          onClose={closeSearch}
        />
      )}
    </div>
  );
}
