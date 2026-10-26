import { useState } from "react";
import {
  cacheHitRatio,
  formatElapsed,
  formatPercent,
  formatSpeed,
  formatUsd,
  totalTokens,
  turnSpeed,
  type CcTurnStat,
} from "../../lib/ccTurnStat";
import { formatTokens } from "../../lib/ccContextUsage";
import { Icon } from "../ui/icon";

/**
 * 轮次脚注：这一轮花了多少 token、吐字多快、用了多久。
 *
 * ## 为什么落在消息流里而不是会话条
 *
 * `SessionBar` 右端已经有六组控件，源码注释写着「700px 窄窗下已经被挤爆过
 * （cwd 截成 `p...`），任何带文字的按钮都会再吃掉 40px」。而「这一轮花了多少」
 * 本来就是**随轮次产生**的信息，贴着这一轮显示最自然，也不占常驻布局。
 *
 * ## 为什么不隐藏任何东西
 *
 * 默认只显示三项（总量 / 速度 / 耗时），点开补全分项。GitHub 上那批 statusline
 * 工具（`ccstatusline`、`claude-hud`）也是这个思路：常驻行只放最常看的两三个数，
 * 明细要么悬停、要么在上下文快满时自动展开。
 *
 * ## 口径写进 title
 *
 * 速度容易被误读成「整轮跑得多快」。这里的分母**只算模型吐字的时间**，工具执行
 * 与审批等待都不计 —— 不说清楚，用户会拿它和墙钟对不上账。
 */
export function TurnFooter({ stat }: { stat: CcTurnStat }) {
  const [open, setOpen] = useState(false);
  const total = totalTokens(stat);
  const speed = turnSpeed(stat.output, stat.genMs);
  const hit = cacheHitRatio(stat);

  // 一行都没有 token 的轮次（纯报错、用户中断）不占位：没有信息量。
  if (total <= 0) return null;

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon
          name={stat.isError ? "alert" : "check"}
          size={10}
          className={stat.isError ? "shrink-0 text-destructive-ink" : "shrink-0 opacity-60"}
        />
        <span className="font-mono">{formatTokens(total)} tok</span>
        {speed !== null && (
          <>
            <span aria-hidden className="opacity-40">
              ·
            </span>
            <span
              className="font-mono"
              title="输出速度：只算模型吐字的时间，工具执行与审批等待不计入"
            >
              {formatSpeed(speed)}
            </span>
          </>
        )}
        {stat.durationMs !== null && (
          <>
            <span aria-hidden className="opacity-40">
              ·
            </span>
            <span className="font-mono" title="整轮墙钟（含模型生成、工具执行与你审批的等待）">
              {formatElapsed(stat.durationMs)}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="用量明细"
          title="用量明细"
          className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <Icon
            name="chevronDown"
            size={9}
            className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {/* 明细原地展开（不浮层）：脚注在滚动容器里，绝对定位的浮层会被裁掉
          —— 见 MEMORY 里那条「一个轴非 visible 另一个轴也变 auto」的坑。 */}
      {open && (
        <div className="ml-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-[2px] border-l border-border pl-2.5 text-[11px] text-muted-foreground">
          <span className="opacity-70">输入</span>
          <span className="font-mono">
            {formatTokens(stat.input + stat.cacheWrite + stat.cacheRead)}
            {hit !== null && (
              <span className="ml-1.5 opacity-60">命中 {formatPercent(hit)}</span>
            )}
          </span>
          <span className="opacity-70">├ 未缓存</span>
          <span className="font-mono">{formatTokens(stat.input)}</span>
          <span className="opacity-70">├ 写缓存</span>
          <span className="font-mono">{formatTokens(stat.cacheWrite)}</span>
          <span className="opacity-70">└ 读缓存</span>
          <span className="font-mono">{formatTokens(stat.cacheRead)}</span>
          <span className="opacity-70">输出</span>
          <span className="font-mono">{formatTokens(stat.output)}</span>
          {stat.genMs !== null && (
            <>
              <span className="opacity-70">生成</span>
              <span className="font-mono">
                {formatElapsed(stat.genMs)}
                {stat.ttftMs !== null && (
                  <span className="ml-1.5 opacity-60">首 token {formatElapsed(stat.ttftMs)}</span>
                )}
              </span>
            </>
          )}
          {stat.costUsd !== null && (
            <>
              <span className="opacity-70">成本</span>
              <span className="font-mono">{formatUsd(stat.costUsd)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
