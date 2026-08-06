import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toolLabel } from "../../lib/utils";
import type { StatusResponse, StaticStatus, LiveStatus } from "../../lib/types";
import { useCountUp } from "../../hooks/useCountUp";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { usePopClass } from "../../hooks/useChangeClass";
import { NavTarget } from "../ui/NavTarget";

/**
 * Bento 右下的健康度卡（4/12 列）。
 *
 * 它要 stats，所以自己订阅 `["status"]`（共享 App 层的缓存与轮询，不多发请求）。
 * 整卡可点 → 日志页：成功率 / 失败数 / 热门工具全部源自审计，明细在那边。
 */

/** 健康度卡：环 + 成功率 + 治理异常计数 + 热门工具。 */
export function HealthCard({
  status,
  onNavigate,
}: {
  status?: StaticStatus;
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const { data: live } = useQuery<StatusResponse, Error, LiveStatus>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    select: (s) => ({ uptimeSeconds: s.uptimeSeconds, stats: s.stats }),
  });

  const running = status?.running ?? false;
  const s = live?.stats;
  const rate = s?.successRate ?? 100;
  const top = s?.topTools ?? [];
  const total = s?.totalRequests ?? 0;

  // 入场数字滚动（仅首次挂载，后续 5s 轮询直接跟随终值）。这是老版本 `useCountUp(rate)`
  // 的原始用法。JS 驱动的动画 CSS 全局兜底管不到，所以要自己查 reduced-motion。
  const reduced = usePrefersReducedMotion();
  const rateAnim = useCountUp(rate, { enabled: running && !reduced, duration: 900 });
  const rateText = running ? `成功率 ${rateAnim.toFixed(1)}%` : "服务未运行";
  const ratePop = usePopClass(rateText);

  return (
    // 整卡可点 → 日志页：成功率 / 失败数 / 热门工具全部源自审计，去日志页才看得到明细。
    <NavTarget
      onNavigate={onNavigate}
      tab="log"
      title="去日志页看调用明细与错误"
      className="bento-card"
    >
      <div className="bento-eyebrow">健康度</div>
      <div className="mt-1.5 flex items-center gap-3.5">
        <HealthRing rate={rate} running={running} />
        <div className="min-w-0">
          <div className="text-[12.5px] font-bold">
            <span className={ratePop}>{rateText}</span>
          </div>
          <div className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
            限流命中 {s?.rateLimitHits ?? 0} · 越权拒绝 {s?.authDenies ?? 0}
            <br />
            失败 {(s?.totalErrors ?? 0).toLocaleString("en-US")} · 审计{" "}
            {(s?.auditCount ?? 0).toLocaleString("en-US")} 条
          </div>
        </div>
      </div>

      {/* 热门工具占比。flex-1 是为了**吃掉多余高度**：本卡在网格第 2 行，
          而那一行的高度由跨两行的状态卡反推出来（比本卡内容高一百多像素），
          不伸缩就会在底部留一大片空白。与指标卡的 sparkline 同一套做法。 */}
      <div className="mt-3 flex flex-1 flex-col justify-end gap-1.5">
        {top.length === 0 || total === 0 ? (
          <p className="text-[10.5px] text-muted-foreground">还没有工具调用</p>
        ) : (
          top.map((t) => (
            <ToolBar key={t.name} name={t.name} count={t.count} total={total} />
          ))
        )}
      </div>
    </NavTarget>
  );
}

/**
 * 单个热门工具的占比条。
 *
 * 分母用 `totalRequests`（而不是 Top3 之和）：前者回答的是“这个工具占全部调用的多少”，
 * 后者会把三个占比强行归一到 100%——那是假的，尾部还有很多其它工具。
 */
function ToolBar({ name, count, total }: { name: string; count: number; total: number }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-[52px] shrink-0 truncate text-muted-foreground" title={toolLabel(name)}>
        {toolLabel(name)}
      </span>
      <span className="tool-bar">
        {/* 用 scaleX 而不是 width：width 变化会触发 layout + paint，
            transform 走纯合成。过渡定义在 index.css 的 `.tool-bar > i`。 */}
        <i style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, pct / 100))})` }} />
      </span>
      <span className="w-[30px] shrink-0 text-right tabular-nums text-muted-foreground">
        {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%
      </span>
    </div>
  );
}

/**
 * 健康度环。从旧 `HeroStats.tsx` 搬过来并改成**白底卡配色**：
 * 原版的轨道是 `rgba(255,255,255,.18)`、中心字是 `#fff`，那是为深色 hero 背景调的，
 * 压在白底卡上看不见。现改为 token 取色，自动适应浅/深两个主题。
 */
function HealthRing({ rate, running }: { rate: number; running: boolean }) {
  const C = 2 * Math.PI * 24;
  const pct = running ? Math.min(100, Math.max(0, rate)) : 0;
  const offset = C * (1 - pct / 100);
  const label = !running
    ? "停"
    : rate >= 99.5
      ? "优"
      : rate >= 98
        ? "良"
        : rate >= 90
          ? "注意"
          : "异常";
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" className="shrink-0" role="img" aria-label={`健康度：${label}`}>
      <defs>
        <linearGradient id="bentoHealthGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#818CF8" />
          <stop offset="1" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
      <circle cx="28" cy="28" r="24" fill="none" stroke="hsl(var(--border))" strokeWidth="5" />
      {pct > 0 && (
        // .health-arc：弧长变化过渡 + 首次从 0 画出（见 index.css）。
        // 不加就是成功率一变、弧长瞬间跳。
        <circle
          className="health-arc"
          cx="28"
          cy="28"
          r="24"
          fill="none"
          stroke="url(#bentoHealthGrad)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={offset}
          transform="rotate(-90 28 28)"
        />
      )}
      <text
        x="28"
        y="33"
        textAnchor="middle"
        fill="hsl(var(--foreground))"
        fontSize="14"
        fontWeight="800"
      >
        {label}
      </text>
    </svg>
  );
}

