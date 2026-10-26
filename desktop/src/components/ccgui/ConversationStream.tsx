import { useCallback, useEffect, useMemo, useRef, type CSSProperties, type RefObject } from "react";
import type { CcProbe } from "../../lib/ccEventTypes";
import { pendingApprovals, type CcView } from "../../lib/ccReducer";
import { CHAT_TYPOGRAPHY, useChatTypography } from "../../lib/chatTypography";
import { useCcConvSearch } from "../../hooks/useCcConvSearch";
import { useCcScrollAway } from "../../hooks/useCcScrollAway";
import { CcEmptyState } from "./CcEmptyState";
import { CcFindBar } from "./CcFindBar";
import { MessageList } from "./MessageList";
import { ScrollToBottom } from "./ScrollToBottom";

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
  view,
  probe,
  probing,
  retryProbe,
  onPickPrompt,
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
  cwd: string;
  onCwdChange: (v: string) => void;
  isRemote: boolean;
  newSessionHint: string;
}) {
  const search = useCcConvSearch(view.messages);
  const { hits, occ, openSearch } = search;
  const { away, toBottom } = useCcScrollAway(scrollRef);
  // 流式输出时 view 每个 tick 都变，但待批准数只随消息列表 / 裁决表变，用 memo 避免每次都全量遍历。
  const pendingCount = useMemo(
    () => pendingApprovals({ messages: view.messages, resolved: view.resolved }).length,
    [view.messages, view.resolved],
  );
  // 正文排版偏好（设计稿《对话页-@引用与排版偏好》C 期）：CSS 变量挂在本容器，
  // MarkdownText 消费 —— 不穿 props 链，所有 pane 同时生效。
  const typo = useChatTypography();
  const typoStyle = {
    "--cc-chat-fs": CHAT_TYPOGRAPHY[typo].px,
    "--cc-chat-lh": CHAT_TYPOGRAPHY[typo].lh,
  } as CSSProperties;

  // Ctrl+F 唤起。🔴 多 pane 各挂一个 window 监听，只让**可见** pane 响应：
  // 隐藏 pane 是 display:none（offsetParent 为 null），正好当可见性判据，
  // 不用为这一个布尔往 CcPane 再穿一条 props（它已顶到体量门限）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
      if (scrollRef.current?.offsetParent == null) return;
      e.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scrollRef, openSearch]);

  // 当前命中滚进视口（nearest：已在视口内就不动）。由此触发的滚动事件会让
  // useCcStreamScroll 自然解除贴底 —— 搜索期间新内容不会把人拽走，这是要的。
  // 🔴 只在「查询词 / 当前命中序号」变化（或命中从无到有）时滚动，不跟着 `hits` 引用走：
  // 流式输出时 `hits` 每个 tick 都重算，跟着它滚会在用户往别处翻阅时反复把视口拉回命中处。
  const scrolledKeyRef = useRef("");
  useEffect(() => {
    if (hits.length === 0) {
      scrolledKeyRef.current = "";
      return;
    }
    const key = `${search.query}\u0000${occ}`;
    if (scrolledKeyRef.current === key) return;
    scrolledKeyRef.current = key;
    scrollRef.current?.querySelector("[data-cc-hit-cur]")?.scrollIntoView({ block: "nearest" });
  }, [scrollRef, hits, occ, search.query]);

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
    <div className="relative min-h-0 flex-1" style={typoStyle}>
      <div ref={scrollRef} data-cc-stream className="page-scroll h-full overflow-y-auto px-3 py-1">
        {/* cc-msgcol：消息列。子节点（每条消息的根元素）离屏跳渲染，见 index.css。 */}
        <div className="cc-msgcol mx-auto flex min-h-full max-w-[820px] flex-col gap-1.5">
          {view.messages.length === 0 ? (
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
              onRespond={onRespond}
              onForkMessage={onForkMessage}
            />
          )}
        </div>
      </div>
      {away && view.messages.length > 0 && (
        <ScrollToBottom pending={pendingCount} running={view.running} onClick={toBottom} />
      )}
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
