import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { formatUptime } from "../../lib/utils";
import type { StatusResponse } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";

/**
 * 连接页顶部 Hero 卡：运行状态 + 地址 + 三指标玻璃小卡 + 大号启停按钮。
 * 停止态：渐变置灰、圆点停脉冲、文案切换、指标显示 --。
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

  // A2. 指标变化弹跳 — 用 ref 追踪上次值，变化时触发 CSS 弹跳动画
  const prevRequests = useRef(status?.stats.totalRequests ?? 0);
  const prevErrors = useRef(status?.stats.totalErrors ?? 0);
  const [popRequests, setPopRequests] = useState(false);
  const [popErrors, setPopErrors] = useState(false);
  useEffect(() => {
    const curR = status?.stats.totalRequests ?? 0;
    const curE = status?.stats.totalErrors ?? 0;
    if (curR !== prevRequests.current) {
      prevRequests.current = curR;
      setPopRequests(true);
      const t = setTimeout(() => setPopRequests(false), 350);
      return () => clearTimeout(t);
    }
    if (curE !== prevErrors.current) {
      prevErrors.current = curE;
      setPopErrors(true);
      const t = setTimeout(() => setPopErrors(false), 350);
      return () => clearTimeout(t);
    }
  }, [status?.stats.totalRequests, status?.stats.totalErrors]);

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

  return (
    <div className={`hero flex flex-col gap-4 ${running ? "hero--live" : "hero-stopped"}`}>
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

      <div className="relative z-[1] grid grid-cols-3 gap-2.5">
        <HeroMetric icon="activity" label="总请求数" value={status?.stats.totalRequests ?? 0} popClass={popRequests ? "hero-metric-pop" : ""} />
        <HeroMetric icon="alert" label="错误数" value={status?.stats.totalErrors ?? 0} popClass={popErrors ? "hero-metric-pop" : ""} />
        <HeroMetric
          icon="clock"
          label="运行时间"
          value={status && running ? formatUptime(liveUptime) : "--"}
          popClass={running ? "hero-uptime--live" : ""}
        />
      </div>

      {/* 启停控制条：左侧状态提示，右侧紧凑高对比按钮 */}
      {status && (
        <div className="relative z-[1] flex flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex-1 text-[11.5px] opacity-80">
              {pending
                ? "请稍候…"
                : running
                  ? "正在监听，远程可连接"
                  : "已停止，点击启动"}
            </span>
            <Button
              onClick={toggleServer}
              disabled={pending}
              className={`min-w-[132px] gap-2 border border-white/20 shadow-md ${
                pending
                  ? "bg-white/10 text-white/50 backdrop-blur-sm"
                  : "bg-white/15 text-white backdrop-blur-sm hover:bg-white/25"
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

          {err && (
            <div className="flex items-center gap-2 rounded-lg border border-white/25 bg-black/25 px-3 py-2 text-[12.5px] text-white/95">
              <Icon name="alertTriangle" size={14} className="shrink-0" />
              <span className="break-all">{err}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HeroMetric({
  icon,
  label,
  value,
  popClass,
}: {
  icon: IconName;
  label: string;
  value: number | string;
  popClass?: string;
}) {
  return (
    <div className="hero-metric">
      <div className={`text-[23px] font-extrabold leading-tight tracking-tight ${popClass ?? ""}`}>{value}</div>
      <div className="mt-1 flex items-center gap-1.5 text-[11.5px] opacity-85">
        <Icon name={icon} size={12} />
        {label}
      </div>
    </div>
  );
}
