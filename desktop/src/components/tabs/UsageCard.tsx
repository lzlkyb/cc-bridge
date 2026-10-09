import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { TokenUsageDay, TokenUsageReport } from "../../lib/types";
import { fmtTokens, shortDateKey } from "../../lib/utils";
import { NavTarget } from "../ui/NavTarget";

/**
 * Bento 行2 的「Token 用量（估算）」卡（4/12 列，方案 B 布局的右侧新卡）。
 *
 * 展示外部 Claude Code 经桥调用工具所消耗 token 的**估算值**：请求参数与工具返回
 * 结果按约 4 字节 ≈ 1 token 折算（口径见后端 audit.rs）。它**不是账单值**——
 * 模型侧的真实消耗发生在远程 Claude Code 与 Anthropic 之间，桥看不到，UI 全程
 * 标注「估算」。
 *
 * 数据：`get_token_usage`（近 7 天按日聚合），复用后端审计解析缓存，30s 轮询。
 * 整卡可点 → 设置页「Token 用量」分区（按日明细 + 工具排行）。
 */
export function UsageCard({
  onNavigate,
}: {
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const { data } = useQuery<TokenUsageReport>({
    queryKey: ["token-usage"],
    queryFn: () => invoke<TokenUsageReport>("get_token_usage", { days: 7 }),
    refetchInterval: 30_000,
  });

  const days = data?.days ?? [];
  const today = days[days.length - 1];
  const todayTotal = today ? today.estInput + today.estOutput : 0;
  const hasData = days.some((d) => d.calls > 0);
  const max = Math.max(...days.map(dayTotal), 1);

  return (
    <NavTarget
      onNavigate={onNavigate}
      tab="settings"
      anchor="set-tokenusage"
      title="去设置页看按日明细与工具排行"
      className="bento-card"
    >
      <div className="bento-eyebrow">
        Token 用量
        <span className="ml-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-bold normal-case tracking-normal text-primary">
          估算
        </span>
      </div>

      {!hasData ? (
        // 空态：大数字 0 + 一句引导。不渲染柱状图（全零柱只有噪声）。
        <div className="mt-2 flex flex-1 flex-col justify-end">
          <div className="text-[22px] font-extrabold leading-tight tabular-nums">0</div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
            暂无调用记录
            <br />
            远程接入后这里会显示估算用量
          </p>
        </div>
      ) : (
        <>
          <div className="mt-1.5">
            <div className="text-[22px] font-extrabold leading-tight tabular-nums">
              {fmtTokens(todayTotal)}
              <span className="ml-1 text-[11px] font-semibold text-muted-foreground">
                tokens · 今日
              </span>
            </div>
            <div className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
              今日 <b className="tabular-nums">{today?.calls ?? 0}</b> 次调用
              <br />
              输入 <b className="tabular-nums">~{fmtTokens(today?.estInput ?? 0)}</b> · 输出{" "}
              <b className="tabular-nums">~{fmtTokens(today?.estOutput ?? 0)}</b>
            </div>
          </div>
          {/* 近 7 天柱状图：flex-1 吃掉卡片剩余高度（行2 被状态卡撑到约两行高，
              原先收在右侧 104px 小容器里、下方大片空白），全宽贴底生长。 */}
          <div className="mt-3 flex min-h-[44px] flex-1 flex-col">
            <div className="usage-minibars flex min-h-0 flex-1 items-end gap-1.5">
              {days.map((d, i) => (
                <UsageBar
                  key={d.date}
                  day={d}
                  pct={Math.max(4, (dayTotal(d) / max) * 100)}
                  today={i === days.length - 1}
                  delay={i * 45}
                />
              ))}
            </div>
            <div className="mt-1.5 flex gap-1.5">
              {days.map((d, i) => (
                <span
                  key={d.date}
                  className="min-w-0 flex-1 truncate text-center text-[8px] text-muted-foreground"
                >
                  {i === days.length - 1 ? "今天" : shortDateKey(d.date)}
                </span>
              ))}
            </div>
          </div>
          <p className="mt-2 text-[9.5px] leading-relaxed text-muted-foreground">
            按经桥请求/响应字节数 ÷4 折算，非账单值
          </p>
        </>
      )}
    </NavTarget>
  );
}

/** 单日合计（输入 + 输出）。 */
function dayTotal(d: TokenUsageDay): number {
  return d.estInput + d.estOutput;
}

/** 单根柱子。原生 title 当 tooltip：悬浮显示「日期 · 当日估算量」，零依赖。
 *  delay：错落生长动画的延迟（ms），从左到右依次冒出。 */
function UsageBar({ day, pct, today, delay }: { day: TokenUsageDay; pct: number; today: boolean; delay?: number }) {
  const label = `${today ? "今天" : shortDateKey(day.date)} · ${fmtTokens(dayTotal(day))}`;
  return (
    <div
      className={`min-w-0 flex-1 rounded-t-[3px] ${today ? "bg-primary" : "bg-primary/25"}`}
      style={{ height: `${pct}%`, animationDelay: delay ? `${delay}ms` : undefined }}
      title={label}
    />
  );
}
