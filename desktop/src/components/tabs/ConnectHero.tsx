import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { formatUptime } from "../../lib/utils";
import type { StatusResponse, StaticStatus, LiveStatus } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { HealthRing, HeroChip, HeroStat, TOOL_LABELS, usePopClass } from "./HeroStats";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useCountUp } from "../../hooks/useCountUp";
import { useAppHidden } from "../../lib/appVisibility";

/**
 * 连接页顶部 Hero 卡（方案 B · 双栏卡片）：
 * 状态行 → 双栏（左:5/12 概览卡片 成功率+健康环 | 右:7/12 2×3 指标网格）
 * → 安全治理 · 热门工具（无标题单行流式） → 启停控制。
 * 背景为升级版数据雨 canvas（负载联动：rpm 越高雨越密越快，空闲稀疏慢速「呼吸」）
 * + 正式实色 hero + 白色 glow 光斑。
 * 所有指标均来自后端真实统计（StatusResponse.stats），停止态将实时性指标置 --。
 */
export function ConnectHero({
  status,
  displayHost,
  port,
  onChanged,
}: {
  /** 不含高频字段（uptime / stats 由本组件自己订阅，见下方）。 */
  status?: StaticStatus;
  displayHost: string;
  port: number;
  onChanged: () => void;
}) {
  const running = status?.running ?? true;
  const reduced = usePrefersReducedMotion();

  // 运行态动态表达已改为纯 CSS（仅保留 .hero-dot 脉冲，零主线程开销）。
  // 2026-08-02：移除 .hero-breathe / .addr-shimmer / .hero-shimmer-flow（持续 paint 累计烧 ~6% CPU）。


  // 实时字段（uptime / stats）由本组件**自己订阅**，不再从 props 里拿。
  //
  // 原因：这两个字段每 5s 轮询都变，若随整个 `StatusResponse` 从 App 层往下传，
  // 顶层引用就每 5s 必换 → Header / ConnectTab 上的 `memo` 弹不住 → 当前 Tab 整棵重渲染。
  // 实查全工程只有本组件读它们，所以把订阅下沉到这里，把重渲染隔离在本组件内。
  // 用同一个 queryKey（["status"]）共享 App 那边的缓存与轮询，**不会多发请求**，
  // 也不在这里设 refetchInterval（轮询由 App 层拥有）。
  const { data: live } = useQuery<StatusResponse, Error, LiveStatus>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    select: (s) => ({ uptimeSeconds: s.uptimeSeconds, stats: s.stats }),
  });

  // 运行时长本地每秒自增，5s 轮询回来时以后端 uptime 为准校准，实现平滑跳秒。
  const [liveUptime, setLiveUptime] = useState(0);
  const uptimeSeconds = live?.uptimeSeconds;
  const appHidden = useAppHidden();
  useEffect(() => {
    if (uptimeSeconds == null || !running) return;
    setLiveUptime(uptimeSeconds);
    // 窗口不可见时不跳秒：每秒一次 setState 会驱动整个 Hero 重渲染，而没人在看。
    // 恢复可见时 App 层会立即 refetch，uptimeSeconds 变化会触发本 effect 重跑并校准。
    if (appHidden) return;
    const timer = setInterval(() => setLiveUptime((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [uptimeSeconds, running, appHidden]);

  // 启停操作的过渡态与失败内联报错。
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleServer = async () => {
    setErr(null);
    setPending(true);
    try {
      await invoke(running ? "stop_mcp_server" : "start_mcp_server");
      onChanged();
    } catch (e) {
      // invoke 的 reject 是后端返回的错误字符串。
      setErr(String(e));
    } finally {
      setPending(false);
    }
  };

  // ── 实时指标（全部来自后端真实统计）──
  const s = live?.stats;
  const total = s?.totalRequests ?? 0;
  const errs = s?.totalErrors ?? 0;
  const rate = s?.successRate ?? 100;
  const rpm = s?.requestsPerMin ?? 0;
  const avg = s?.avgLatencyMs ?? 0;
  const p95 = s?.p95LatencyMs ?? 0;
  const rateLimitHits = s?.rateLimitHits ?? 0;
  const authDenies = s?.authDenies ?? 0;
  const auditCount = s?.auditCount ?? 0;
  const activeCommands = s?.activeCommands ?? 0;
  const topTools = s?.topTools ?? [];

  const fmt = (n: number) => n.toLocaleString("en-US");
  // 指标数字 count-up 入场（仅首次挂载滚动一次；轮询更新不重播，避免乱跳）
  const rateAnim = useCountUp(rate, { enabled: running && !reduced, duration: 900 });
  const totalAnim = useCountUp(total, { enabled: !reduced });
  const errsAnim = useCountUp(errs, { enabled: !reduced });
  const rateText = status ? `${rateAnim.toFixed(1)}%` : "--";
  const rpmText = running ? `${rpm}/min` : "--";
  const avgText = running ? `${avg}ms` : "--";
  const p95Text = running ? `${p95}ms` : "--";
  const activeText = running ? String(activeCommands) : "0";
  const uptimeText = running ? formatUptime(liveUptime) : "--";
  const ratePop = usePopClass(rateText);

  return (
    <div className={`hero relative flex flex-col gap-2 overflow-hidden ${running ? "hero--live" : "hero-stopped"}`}>
      {/* 顶部流光 hero-shimmer-seg 已移除（transform: translateX 动画，CPU 占用 ~1%） */}
      {/* 状态行 */}
      <div className="relative z-[1] flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-[15px] font-semibold">
          <span className={`h-2.5 w-2.5 rounded-full bg-white text-white ${running ? "hero-dot" : "opacity-50"}`} />
          {!status ? "启动中…" : running ? "服务运行中" : "服务已停止"}
        </div>
        {status && (
          <span className={`hero-addr rounded-full px-3 py-1 font-mono text-xs ${running ? "hero-addr--live" : ""}`}>
            {displayHost} : {port}
          </span>
        )}
      </div>

      {/* 双栏：左概览卡片 + 右 2×3 指标网格 */}
      <div className="relative z-[1] grid grid-cols-12 gap-2.5 items-stretch">
        {/* 左栏：概览卡片（成功率 + 健康环合并） */}
        <div className="col-span-5 hero-metric hero-overview flex flex-col justify-center gap-0.5">
          <div className="hero-sec-label">服务健康度 · 实时成功率</div>
          <div className="flex items-end gap-2.5">
            <div className={`text-[36px] font-extrabold leading-none tracking-tight ${ratePop}`}>{rateText}</div>
            <div className="text-[10.5px] opacity-75 mb-1">累计</div>
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <HealthRing rate={rate} running={running} />
            <div className="flex-1 text-[11.5px] leading-relaxed opacity-85">
              运行正常
            </div>
          </div>
        </div>
        {/* 右栏：2×3 指标网格 */}
        <div className="col-span-7 grid grid-cols-3 gap-1.5">
          <HeroStat icon="activity" label="请求速率" value={rpmText} />
          <HeroStat icon="clock" label="平均耗时" value={avgText} />
          <HeroStat icon="alertTriangle" label="慢请求 P95" value={p95Text} sub="95% 请求快于此" />
          <HeroStat icon="clock" label="运行时间" value={uptimeText} />
          <HeroStat icon="server" label="累计请求" value={fmt(totalAnim)} />
          <HeroStat icon="alertTriangle" label="错误次数" value={fmt(errsAnim)} />
        </div>
      </div>

      {/* 底部行：安全治理 · 热门工具（无标题，单行流式） */}
      <div className="relative z-[1]">
        <div className="flex flex-wrap items-center gap-2">
          <HeroChip icon="shield" label="限流命中" value={fmt(rateLimitHits)} />
          <HeroChip icon="lock" label="越权拒绝" value={fmt(authDenies)} />
          <HeroChip icon="log" label="审计" value={`${fmt(auditCount)} 条`} />
          <HeroChip icon="terminal" label="活跃命令" value={activeText} />
          {topTools.length === 0 ? (
            <span className="hero-pill tool opacity-70">暂无调用</span>
          ) : (
            topTools.map((t) => (
              <span className="hero-pill tool" key={t.name}>
                <Icon name="terminal" size={12} />
                {TOOL_LABELS[t.name] ?? t.name} <b>{fmt(t.count)}</b>
              </span>
            ))
          )}
        </div>
      </div>

      {/* 启停控制条 */}
      {status && (
        <div className="relative z-[1] pt-2">
          {/* 渐变分隔线：中段可见，两端渐隐，替代 border-t 实线 */}
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.12] to-transparent" />
          <div className="flex items-center gap-2.5">
          <span className="flex-1 text-[11.5px] opacity-90">
            {pending
              ? "请稍候…"
              : running
                ? "正在监听，远程可连接"
                : "已停止，点击启动"}
          </span>
          <Button
            onClick={toggleServer}
            disabled={pending}
            className={`min-w-[132px] gap-2 rounded-lg transition-shadow ${
              pending
                ? "bg-white/10 text-white/50 backdrop-blur-[6px] shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_4px_8px_-4px_rgba(0,0,0,0.10)]"
                : "bg-white/15 text-white backdrop-blur-[6px] shadow-[0_0_0_1px_rgba(255,255,255,0.10),0_8px_16px_-4px_rgba(0,0,0,0.18),0_4px_8px_-4px_rgba(0,0,0,0.12)] hover:bg-white/20 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.18),0_12px_24px_-6px_rgba(0,0,0,0.22),0_6px_12px_-6px_rgba(0,0,0,0.14)]"
            }`}
          >
            {pending ? (
              <Icon name="spinner" size={16} className="animate-spin" />
            ) : (
              <Icon name={running ? "pause" : "play"} size={16} />
            )}
            {pending
              ? running
                ? "停止中…"
                : "启动中…"
              : running
                ? "停止服务"
                : "启动服务"}
          </Button>
          </div>
        </div>
      )}

      {err && (
        <div className="relative z-[1] flex items-center gap-2 rounded-lg border border-white/25 bg-black/25 px-3 py-2 text-[12.5px] text-white/95">
          <Icon name="alertTriangle" size={14} className="shrink-0" />
          <span className="break-all">{err}</span>
        </div>
      )}
    </div>
  );
}
