import { useState } from "react";
import {
  CONTEXT_WARN_RATIO,
  contextPercent,
  formatTokens,
  type CcContextBar,
} from "../../lib/ccContextUsage";
import { useCcContextTax } from "../../hooks/useCcContextTax";
import { Icon } from "../ui/icon";
import { ContextTaxPanel } from "./ContextTaxPanel";

/**
 * 会话条右端的上下文计量表：余量条 + 构成面板入口（批 4-1）。
 *
 * ## 为什么落点是「余量条本身」
 *
 * 会话条在 700px 主区宽度下已经被挤爆过（cwd 都截成 `p...`），再加一个按钮必然
 * 挤压。而用户看到 `40.2K/200K` 时最想问的正是「被什么吃掉了」—— 点它最直觉，
 * 且**零新增占位**。
 *
 * ## 为什么这里就查（面板关着也查）
 *
 * 除了面板内容，这个组件还负责余量条上的**降级警示点**：客户端把某次工具结果
 * 整条降级成 2KB 预览时，模型当轮根本没看到内容 —— 这件事必须在用户没点开面板时
 * 就能看见，否则他会一直在别处找原因。代价是每轮结束扫一次 `audit.log`
 * （走 mtime/len 缓存，且同一 sessionId 的 query 与面板共享，不会查两遍）。
 *
 * ## 两种形态都可点
 *
 * CLI 没报 `contextWindow` 时 `bar` 为 `null`（老版本 CLI / 未知模型），退回只显示
 * 已用 token 的旧形态 —— 但构成面板照样能开，构成跟窗口大小无关。
 */
export function ContextMeter({
  bar,
  tokens,
  sessionId,
  running,
}: {
  /** `contextBar(modelUsage)` 的结果。`null` = CLI 没报窗口。 */
  bar: CcContextBar | null;
  /** 各模型累计 token 合计，`bar` 为 `null` 时显示它。 */
  tokens: number;
  /** **CC 的** session id（不是 cc-bridge 内部 id，见 `CcSession.sessionId`）。 */
  sessionId: string | null;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  // `enabled` 恒真：见组件头注释「为什么这里就查」。
  const tax = useCcContextTax(sessionId, true, running);
  const drop = (tax.data?.droppedTotal ?? 0) > 0;
  const clip = !drop && (tax.data?.oversizedTotal ?? 0) > 0;
  const warn = bar !== null && bar.ratio >= CONTEXT_WARN_RATIO;

  const alert = drop ? (
    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
  ) : clip ? (
    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
  ) : null;

  const title = bar
    ? `上下文已用 ${formatTokens(bar.used)} / 窗口 ${formatTokens(bar.window)}` +
      `（${bar.model}，${contextPercent(bar)}%）` +
      (warn ? " · 已超过 80%，可发送 /compact 压缩上下文" : "") +
      (drop
        ? ` · ⚠ ${tax.data?.droppedTotal} 次工具结果被客户端整条降级（模型没看到）`
        : clip
          ? ` · ${tax.data?.oversizedTotal} 次工具结果顶到裁剪线`
          : "") +
      " · 点击查看被什么吃掉"
    : "输入 + 输出 token · 点击查看被什么吃掉";

  return (
    <span className="relative flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        className={`flex items-center gap-1.5 rounded-md px-1 py-[1px] font-mono text-[11px] transition-colors hover:bg-muted/60 ${
          open ? "bg-muted/60 text-foreground" : warn ? "text-warning-ink" : "text-muted-foreground"
        }`}
      >
        {bar && (
          // 纯视觉条：数字就在旁边，读屏软件读文字，这条 aria 隐藏。
          <span aria-hidden className="relative h-[4px] w-10 overflow-hidden rounded-full bg-muted">
            <span
              className={`absolute inset-y-0 left-0 rounded-full ${warn ? "bg-warning" : "bg-primary/70"}`}
              style={{ width: `${contextPercent(bar)}%` }}
            />
          </span>
        )}
        {bar ? `${formatTokens(bar.used)}/${formatTokens(bar.window)}` : formatTokens(tokens)}
        {alert}
        <Icon name="chevronDown" size={9} className="shrink-0 opacity-50" />
      </button>
      {open && (
        <ContextTaxPanel
          tax={tax.data ?? null}
          loading={tax.isFetching}
          used={bar?.used ?? tokens}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
