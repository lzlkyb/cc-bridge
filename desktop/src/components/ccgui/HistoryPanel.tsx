import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "../../lib/tauri";
import type { CcHistoryList, CcHistoryRow } from "../../lib/ccEventTypes";
import { isOutsideDismiss } from "../../lib/utils";
import { formatRelativeSecs } from "../../lib/utils";
import { highlightSegments } from "../../lib/ccHighlight";
import { Icon } from "../ui/icon";
import { useAnchoredPopover } from "../../hooks/useAnchoredPopover";

/**
 * 历史会话面板。
 *
 * ## 为什么是下拉面板而不是侧栏
 *
 * 对话页在 700px 窄窗下已经被会话条和消息区挤满（会话条里 cwd 被截成 `p...`
 * 就是证据）。侧栏至少要吃掉 240px，剩下给消息的宽度不到 460px，
 * 而代码块、diff、工具卡这些恰恰需要宽度。
 *
 * ## 为什么不占布局
 *
 * 面板走 `absolute` 浮在消息区上：它一旦占高度，消息区会在打开的瞬间收缩，
 * 正在读的位置跟着跳。终端页那边「浮层占高度会触发 `fit` → 远端 TUI 重排」
 * 是同一个道理，只是代价换成滚动位置丢失。
 *
 * ## 每次打开都重新扫
 *
 * 不做「缓存列表 + 增量刷新」：扫描有二级门禁（`size` + `mtime` 没变就不打开
 * 文件），第二次以后是纯查库。反过来做成常驻缓存，用户刚在终端里聊完一轮
 * 切回来看不到那条 —— 这类「要手动刷新一下」的毛病不值得省那几毫秒。
 *
 * ## 搜索在 Rust 收窄，高亮在前端
 *
 * 输入停手 150ms 才带关键词重新调一次 `cc_history_list`：SQL 侧按「3 字滑窗
 * AND」过滤（口径见 `cc_history::index::search`），前端用同一套切片规则把命中
 * 片段涂成 `<mark>`。两边规则必须同步改。
 */

/** 搜索防抖：停手这么久才真正查库。 */
const SEARCH_DEBOUNCE_MS = 150;

export function HistoryPanel({
  onOpen,
  onClose,
  anchorRef,
}: {
  onOpen: (row: CcHistoryRow) => void;
  onClose: () => void;
  /** 历史按钮的容器。浮层按它的 rect 定位（fixed + clamp）。 */
  anchorRef: RefObject<HTMLElement>;
}) {
  const [data, setData] = useState<CcHistoryList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredPopover(anchorRef, true, { width: 380, align: "end", maxH: 420 });
  /** 请求序号：慢的全量扫描可能晚于快的过滤查询返回，旧响应回来必须丢弃，
   *  否则搜索框已清空、列表却停在过期的过滤结果上。 */
  const reqSeqRef = useRef(0);

  const load = useCallback(async (q: string) => {
    const token = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<CcHistoryList>("cc_history_list", { query: q });
      if (token !== reqSeqRef.current) return;
      setData(res);
    } catch (e) {
      if (token !== reqSeqRef.current) return;
      setError(String(e));
    } finally {
      if (token === reqSeqRef.current) setLoading(false);
    }
  }, []);

  // 首次（query 为空）立即加载；之后每次改动停手 150ms 再查。扫描有两级门禁，
  // 重复调用的成本接近零，但打字过程中每个键都扫一遍仍属浪费。
  // 清空搜索走 0ms：用户删完最后一个字时，列表应当立刻回来。
  useEffect(() => {
    const t = setTimeout(() => void load(query), query === "" ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, load]);

  // 点外面关掉 + Esc 关掉。用 `pointerdown` 而不是 `click`：
  // 用户按下的那一刻就该收，等 `click` 会先看到消息区被点中。
  // 开关按钮自身不算外点（`isOutsideDismiss` 的理由写在那边）。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (isOutsideDismiss(e, boxRef.current, "history")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const rows = data?.rows ?? [];

  /**
   * 🔴 定位交给 `useAnchoredPopover`（fixed + 视口 clamp），不能用 `absolute right-0`。
   * 上一版把 `left-0` 改成 `right-0` 只挡住了「越过 pane 右边界」，漏了另一半：
   * 会话条 `flex-wrap` 之后这一组会整组换到第二行、贴到 pane 左端，380px 宽的面板
   * 从那里向左伸，前半截又被 `data-cc-panel` 的 `overflow-hidden` 切掉。
   * 两个边界都得管，所以按锚点 rect 算坐标才是完整解法。
   */
  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="历史对话"
      style={style}
      className="z-30 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="history" size={12} className="shrink-0 opacity-70" />
        <span className="text-[12px] font-semibold text-foreground">历史对话</span>
        {data && (
          <span className="text-[11px] text-muted-foreground">
            {query ? `命中 ${rows.length} 条` : `${rows.length} 条 · ${data.tookMs}ms`}
          </span>
        )}
        <button
          type="button"
          onClick={() => void load(query)}
          disabled={loading}
          title="重新扫描"
          aria-label="重新扫描"
          className="ml-auto flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <Icon name="refresh" size={11} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <Icon name="close" size={11} />
        </button>
      </div>

      {/* 搜索框：打开即聚焦。放在头部下面而不是盖在列表上 —— 它要占一行，
          但面板本来就是浮层，不挤占消息区。 */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2">
          <Icon name="search" size={11} className="shrink-0 opacity-60" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题与摘要…"
            aria-label="搜索历史会话"
            autoFocus
            className="h-[24px] w-full bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query !== "" && (
            <button
              type="button"
              onClick={() => setQuery("")}
              title="清空搜索"
              aria-label="清空搜索"
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="close" size={10} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && rows.length === 0 && (
          <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">正在扫描…</p>
        )}
        {error && (
          <p className="px-3 py-6 text-center text-[11px] text-destructive-ink">{error}</p>
        )}
        {!loading && !error && rows.length === 0 && (
          <p className="px-3 py-6 text-center text-[11px] leading-[1.7] text-muted-foreground">
            {query
              ? `没有匹配「${query}」的会话。中文按 3 字片段匹配，记不全可以少打几个字。`
              : data?.dirFound === false
                ? "本机还没有 Claude Code 的转录目录。用对话页或终端聊过一次之后，这里就会出现记录。"
                : "还没有历史会话。"}
          </p>
        )}
        {rows.map((row) => (
          <button
            key={`${row.connectionId}:${row.sessionId}`}
            type="button"
            onClick={() => onOpen(row)}
            className="flex w-full flex-col items-start gap-[3px] border-b border-border/60 px-3 py-2 text-left transition-colors last:border-0 hover:bg-muted/50"
          >
            <span className="line-clamp-2 w-full text-[12px] leading-[1.45] text-foreground">
              <Highlighted text={row.title} query={query} />
            </span>
            {/* 摘要（首条用户消息）。搜索口径里它和标题并列，平时也有用 ——
                看列表就知道那条会话聊过什么。 */}
            {row.preview && (
              <span className="line-clamp-2 w-full text-[11px] leading-[1.45] text-muted-foreground">
                <Highlighted text={row.preview} query={query} />
              </span>
            )}
            <span className="flex w-full items-center gap-2 text-[11px] text-muted-foreground">
              <span className="shrink-0">{formatRelativeSecs(row.lastUsedAt)}</span>
              <span className="shrink-0">·</span>
              <span className="shrink-0">{row.messageCount} 轮</span>
              {row.cwd && (
                <>
                  <span className="shrink-0">·</span>
                  {/* cwd 可能很长：截断在中间没意义，直接尾部省略。 */}
                  <span className="truncate font-mono opacity-80" title={row.cwd}>
                    {row.cwd}
                  </span>
                </>
              )}
              {row.connectionId !== "" && (
                <span className="ml-auto shrink-0 rounded bg-muted px-1 py-px opacity-80">
                  远端
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      {data && data.failed > 0 && (
        <p className="shrink-0 border-t border-border bg-warning/[.06] px-3 py-1.5 text-[11px] leading-[1.5] text-warning-ink">
          有 {data.failed} 份转录读不开（权限或文件损坏），它们不在上面的列表里。
        </p>
      )}
    </div>
  );
}

/**
 * 命中高亮。`<mark>` 的配色沿用终端全局搜索的那一套
 * （`TerminalGlobalSearch` 里同款类名），不另造。
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="rounded bg-primary/25 text-foreground">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}
