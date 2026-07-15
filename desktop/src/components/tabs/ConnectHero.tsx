import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { formatUptime } from "../../lib/utils";
import type { StatusResponse } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { HealthRing, HeroChip, HeroStat, TOOL_LABELS, usePopClass } from "./HeroStats";

/**
 * 连接页顶部 Hero 卡（方案 A · 分组清晰 · 方案1基础上再压缩）：
 * 状态行 → 概览区(成功率 hero 大数字 + 健康度环) → 核心性能 2×3 网格
 * → 安全治理 · 热门工具 Top3(合并一行) → 启停控制。
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
  status?: StatusResponse;
  displayHost: string;
  port: number;
  onChanged: () => void;
}) {
  const running = status?.running ?? true;

  // 炫酷背景：数据流瀑布(Matrix)——负载联动：rpm 越高雨越密越快，空闲稀疏慢速「呼吸」。
  // rpm 经 ref 传入动画循环，不进 effect 依赖（避免每次轮询重启动画闪烁）。
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rpmRef = useRef(0);
  useEffect(() => {
    rpmRef.current = running ? status?.stats?.requestsPerMin ?? 0 : 0;
  }, [status, running]);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0, raf = 0, t = 0;
    const GLYPHS = ["0", "1", "{", "}", "<", ">", "/", "\\", "∑", "λ", "%", "★", "·"];
    const COLW = 15;
    let cols = 0;
    let drops: number[] = [];
    let thr: number[] = []; // 每列激活阈值，空闲时按阈值均匀隐藏部分列
    const fit = () => {
      const r = cv.getBoundingClientRect();
      W = r.width; H = r.height;
      cv.width = Math.max(1, W * DPR); cv.height = Math.max(1, H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      cols = Math.ceil(W / COLW);
      drops = Array.from({ length: cols }, () => Math.random() * H);
      thr = Array.from({ length: cols }, () => Math.random());
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(cv);
    const isDark = () => document.documentElement.classList.contains("dark");
    let curLoad = 0; // 负载缓动值（向 rpm 决定的 targetLoad 追随，避免轮询跳变时雨突变）
    const draw = () => {
      t += 1;
      const targetLoad = Math.min(1, rpmRef.current / 120);
      curLoad += (targetLoad - curLoad) * 0.05;
      const load = curLoad;
      const speed = 0.5 + load * 2.4;       // 空闲 0.5 → 峰值 ~2.9（rpm≈120）
      const density = 0.42 + load * 0.58;   // 激活列比例 0.42 → 1.0
      ctx.clearRect(0, 0, W, H);
      const dark = isDark();
      const indigo = dark ? "129,140,248" : "79,70,229";
      const cyan = dark ? "56,189,248" : "14,165,233";
      ctx.font = "13px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "center";
      // 数据流瀑布（升级版）：头部亮青 + 微 glow，平滑拖尾
      const TAIL = 16;
      for (let i = 0; i < cols; i++) {
        if (thr[i] > density) continue;     // 该列空闲时不落、不画
        const x = i * COLW + COLW / 2;
        const y = drops[i];
        // 头部：亮青 + 轻微 glow（仅头部，远比逐帧全屏 glow 省）
        ctx.shadowBlur = 6;
        ctx.shadowColor = `rgba(${cyan},0.9)`;
        ctx.fillStyle = `rgba(${cyan},0.98)`;
        ctx.fillText(GLYPHS[(Math.floor(t * 0.03) + i) % GLYPHS.length], x, y);
        ctx.shadowBlur = 0;
        // 拖尾：青→靛蓝渐变，透明度 (1-k/TAIL)^1.6 平滑
        for (let k = 1; k <= TAIL; k++) {
          const ty = y - k * 15;
          if (ty < -15) continue;
          const a = 0.42 * Math.pow(1 - k / TAIL, 1.6);
          const col = k / TAIL < 0.5 ? cyan : indigo;
          ctx.fillStyle = `rgba(${col},${a})`;
          ctx.fillText(GLYPHS[(Math.floor(t * 0.03) + i + k) % GLYPHS.length], x, ty);
        }
        drops[i] += speed * (1 + (i % 3) * 0.18);
        if (drops[i] > H + 30) drops[i] = -Math.random() * 120;
      }
      if (running) raf = requestAnimationFrame(draw);
    };
    draw();
    // 后台暂停：切到别的 tab 时停止 rAF，避免空转
    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else if (running) {
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [running]);

  // 运行时长本地每秒自增，5s 轮询回来时以后端 uptime 为准校准，实现平滑跳秒。
  const [liveUptime, setLiveUptime] = useState(0);
  const uptimeSeconds = status?.uptimeSeconds;
  useEffect(() => {
    if (uptimeSeconds == null || !running) return;
    setLiveUptime(uptimeSeconds);
    const timer = setInterval(() => setLiveUptime((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [uptimeSeconds, running]);

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
  const s = status?.stats;
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
  const rateText = status ? `${rate.toFixed(1)}%` : "--";
  const rpmText = running ? `${rpm}/min` : "--";
  const avgText = running ? `${avg}ms` : "--";
  const p95Text = running ? `${p95}ms` : "--";
  const activeText = running ? String(activeCommands) : "0";
  const uptimeText = running ? formatUptime(liveUptime) : "--";
  const ratePop = usePopClass(rateText);

  return (
    <div className={`hero relative flex flex-col gap-2.5 overflow-hidden ${running ? "hero--live" : "hero-stopped"}`}>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-0 h-full w-full" aria-hidden="true" />
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

      {/* 概览区：成功率 hero 大数字 + 健康度环 */}
      <div className="relative z-[1] grid grid-cols-12 gap-2.5 items-stretch">
        <div className="col-span-7 hero-metric hero-overview flex flex-col justify-center">
          <div className="hero-sec-label">服务健康度 · 实时成功率</div>
          <div className="flex items-end gap-3">
            <div className={`hero-val-xl ${ratePop}`}>{rateText}</div>
            <div className="text-[11px] opacity-80 mb-0.5">累计</div>
          </div>
        </div>
        <div className="col-span-5 hero-metric flex flex-col">
          <div className="hero-sec-label">综合健康度</div>
          <div className="flex items-center gap-2.5 mt-0.5">
            <HealthRing rate={rate} running={running} />
            <div className="flex-1 text-[11.5px] leading-relaxed opacity-85">
              运行正常
            </div>
          </div>
        </div>
      </div>

      {/* 核心性能 2×3 */}
      <div className="relative z-[1] grid grid-cols-3 gap-1.5">
        <HeroStat icon="activity" label="请求速率" value={rpmText} />
        <HeroStat icon="clock" label="平均耗时" value={avgText} />
        <HeroStat icon="alertTriangle" label="慢请求 P95" value={p95Text} sub="95% 请求快于此" />
        <HeroStat icon="clock" label="运行时间" value={uptimeText} />
        <HeroStat icon="server" label="累计请求" value={fmt(total)} />
        <HeroStat icon="alertTriangle" label="错误次数" value={fmt(errs)} />
      </div>

      {/* 安全治理 · 热门工具 Top3（合并一行，省一整块标题+间距） */}
      <div className="relative z-[1]">
        <div className="hero-sec-label" style={{ color: "rgba(255,255,255,0.88)" }}>安全治理 · 热门工具 Top3</div>
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
