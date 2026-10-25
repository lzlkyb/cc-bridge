import { useEffect, useMemo, useRef } from "react";
import {
  breakdown,
  formatBytes,
  formatK,
  percentOf,
  severityOf,
  warnLevel,
  type CcContextTax,
} from "../../lib/ccContextTax";
import { Icon } from "../ui/icon";
import { isOutsideDismiss } from "../../lib/utils";

/**
 * 上下文构成面板（批 4-1）。
 *
 * 回答一个问题：**这一屏上下文被什么吃掉了**。
 *
 * ## 为什么「其他」这一档非有不可
 *
 * 经桥的工具结果只占一部分。剩下的系统提示、对话正文、以及 CC **内置**工具
 * （Read/Bash/Grep 不走桥，进不了工具账）全都在这一档里。只报工具那一块，
 * 用户会问「工具才 8K，那 40K 哪来的」—— 差额本身就是信息。
 *
 * ## 两档告警不能合成一句
 *
 * - `clip`（≥45,000 字符）：**我们自己**裁的，尾部丢了但内容到了；
 * - `drop`（≥49,823 字符）：**客户端**把整条降级成 2KB 预览，模型当轮没看到、
 *   也不会回读。后者才是事故 —— 用户抱怨「它说没看到文件」时答案就在这里。
 *
 * 浮层不占布局（`absolute`，同 HistoryPanel / ApprovalAuditPanel）：占高度会触发消息区
 * 收缩，正在读的位置跟着跳。
 */
export function ContextTaxPanel({
  tax,
  loading,
  used,
  onClose,
}: {
  tax: CcContextTax | null;
  loading: boolean;
  /** 当前上下文已用 token（与会话条余量条同源）。 */
  used: number;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const view = useMemo(() => breakdown(tax, used), [tax, used]);
  const level = warnLevel(tax);

  // 点外面关 + Esc 关（`pointerdown` 按下即收，同 HistoryPanel）。
  //
  // 🔴 必须走 `isOutsideDismiss` 并让开关按钮带上 `data-cc-toggle`：这里监听的是
  // **捕获阶段**的 `pointerdown`，它比按钮自己的 `click` 先跑。若开关按钮不算「自己人」，
  // 点它就是「先关掉、再被 click 翻回打开」—— 表现是从按钮关不掉这个面板。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (isOutsideDismiss(e, boxRef.current, "context")) onClose();
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

  const toolShare = view.total > 0 ? Math.min(100, percentOf((tax?.estTokens ?? 0) / view.total)) : 0;

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="上下文构成"
      className="absolute right-0 top-full z-40 mt-1 flex w-[min(328px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 pb-2 pt-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[12px] font-semibold text-foreground">上下文构成</span>
          <span className="text-[10.5px] text-muted-foreground">与余量条同源</span>
          <span className="ml-auto font-mono text-[11px] tabular-nums text-foreground">
            {view.total > 0 ? `${formatK(view.total)} token` : "—"}
          </span>
        </div>
        {/* 两段比例条：主色 = 工具结果，浅色 = 其他。单色条只能看出「用了多少」，
            看不出「被什么吃掉」，而后者才是这个面板存在的理由。 */}
        {view.total > 0 && (
          <span aria-hidden className="flex h-[5px] overflow-hidden rounded-full bg-muted">
            <span className="h-full bg-primary/85" style={{ width: `${toolShare}%` }} />
            <span className="h-full bg-foreground/20" style={{ width: `${100 - toolShare}%` }} />
          </span>
        )}
      </div>

      {loading && !tax ? (
        <p className="px-3 py-4 text-[11px] text-muted-foreground">正在统计这一轮的构成…</p>
      ) : view.empty ? (
        <p className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
          这条会话还没有「经桥」的工具调用。
          <br />
          CC 内置的 Read / Bash / Grep 不走桥，它们与系统提示一起计在「其他」里。
        </p>
      ) : (
        <div className="flex flex-col px-3 py-2">
          {view.rows.map((r) => (
            <div key={r.key}>
              <div
                className={`flex items-baseline gap-2 py-[3px] ${
                  r.kind === "tool" ? "pl-3" : ""
                }`}
              >
                <span
                  className={`min-w-0 flex-1 truncate ${
                    r.kind === "group" || r.kind === "other"
                      ? "text-[12px] font-semibold"
                      : "font-mono text-[11px] text-foreground/85"
                  } ${r.hot ? "text-warning-ink" : ""}`}
                  title={r.hot ? "该工具存在越过裁剪线的调用（见下方告警）" : undefined}
                >
                  {r.label}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground">
                  {formatK(r.tokens)}
                </span>
                <span className="w-8 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-muted-foreground">
                  {r.calls !== undefined ? `${r.calls} 次` : `${percentOf(r.share)}%`}
                </span>
              </div>
              {r.kind === "other" && (
                <p className="pb-1 pl-0 text-[10.5px] leading-snug text-muted-foreground">
                  {view.compressed
                    ? "压缩过：压缩前计入的工具结果已不在当前上下文里"
                    : "系统提示 + 对话正文 + CC 内置工具"}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {level !== "none" && tax && (
        <div className="mx-3 mb-2.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-warning-ink">
            <Icon name="alertTriangle" size={11} className="shrink-0" />
            {/* 标题必须把两档都数清：只报 drop 的条数却在下面列了 clip 的条目，
                用户会问「另那一条算什么」（第一版真机核出来就是这个毛病）。 */}
            {level === "drop"
              ? `${tax.droppedTotal} 次被整条降级` +
                (tax.oversizedTotal > tax.droppedTotal
                  ? ` · 另 ${tax.oversizedTotal - tax.droppedTotal} 次顶到裁剪线`
                  : "")
              : `${tax.oversizedTotal} 次顶到裁剪线`}
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-foreground/80">
            {level === "drop"
              ? "降级的那几次模型当轮没看到内容，也不会回读；裁剪的那几次内容到了，只是尾部被截。"
              : "结果尾部被截断（内容仍然到达了模型），缩短单次读取可以避免。"}
          </p>
          <div className="mt-1.5 flex flex-col gap-1">
            {tax.oversized.map((h, i) => {
              const drop = severityOf(h) === "drop";
              return (
                <div
                  key={`${h.tool}-${h.timestamp}-${i}`}
                  className="flex items-baseline gap-2 border-t border-warning/25 pt-1 text-[10.5px]"
                >
                  <span
                    className={`min-w-0 flex-1 truncate font-mono ${drop ? "text-foreground/90" : "text-muted-foreground"}`}
                    title={h.target}
                  >
                    {h.tool} · {h.target || "（未记参数）"}
                  </span>
                  <span
                    className={`shrink-0 font-mono tabular-nums ${drop ? "text-warning-ink" : "text-muted-foreground"}`}
                  >
                    {formatBytes(h.resultBytes)}
                  </span>
                </div>
              );
            })}
          </div>
          {tax.oversizedTotal > tax.oversized.length && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              另有 {tax.oversizedTotal - tax.oversized.length} 次未列出（审计日志页可查全部）
            </p>
          )}
          {tax.charlessCalls > 0 && (
            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
              其中 {tax.charlessCalls} 条来自旧版日志（只记了字节），中文内容可能被高估。
            </p>
          )}
        </div>
      )}

      <p className="shrink-0 border-t border-border px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
        工具账按「≈4 字节 = 1 token」估算，是对话账的一部分，不相加。
        {tax && tax.paramsBytes > 0 && ` 入参另计 ${formatBytes(tax.paramsBytes)}。`}
      </p>
    </div>
  );
}
