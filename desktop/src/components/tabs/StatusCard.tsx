import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { formatUptime } from "../../lib/utils";
import type { StatusResponse, StaticStatus, LiveStatus } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useAppHidden } from "../../lib/appVisibility";
import { useRemoteActivity } from "../../lib/metricHistory";
import { computeChain, type ChainTone } from "../../lib/serviceChain";
import { useChangeClass } from "../../hooks/useChangeClass";
import { ServiceChain } from "./ServiceChain";
import { RecentActivity } from "./RecentActivity";
import { StopClick } from "../ui/NavTarget";
import { useToast } from "../ui/toast";

/** 四种基调对应的背景渐变。定义在 index.css（需要 dark 变体，Tailwind 行内写不下）。 */
const TONE_CLASS: Record<ChainTone, string> = {
  live: "status-card--live",
  warn: "status-card--warn",
  error: "status-card--error",
  stopped: "status-card--stopped",
};

/**
 * pending 态的最短可见时长。
 *
 * 重启是 `stop_mcp_server` + `start_mcp_server` 两个本地调用，往往几十毫秒就返回——
 * spinner 一闪而过等于没有反馈，用户会以为按钮根本没响应。
 * 真实耗时超过 400ms 时这里不介入，所以不是假动画。
 */
const MIN_PENDING_MS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 连接页 Bento 的状态主卡（3/12 列、跨两行）。
 *
 * 它要回答的唯一问题是「远程现在能不能连上来」——所以英雄位是**链路图**而不是
 * 一个大数字。（旧设计把“累计成功率”放在 46px 字号上，但那个值几乎永远是 99%+，
 * 占据了最大视觉权重却是最不会变、信息量最低的一个数。）
 *
 * **为何自己订阅 live 字段**：`uptimeSeconds` / `stats` 每 5s 都变，若从父层传下来，
 * 整个 Bento 子树会跟着每 5s 重渲。这里用同一个 queryKey 共享 App 层的缓存与轮询，
 * **不多发请求**，也不在这里设 `refetchInterval`（轮询由 App 层拥有）。
 *
 * **为何没有「一键放行」按钮**（与设计稿的差异）：防火墙未放行时，`noRule` 在
 * `BLOCKING_CODES` 里，页面顶部的 `FirewallAlertBlock` 几乎必然已经在显示，
 * 而且它做得更全（列具体问题、区分能不能一键修）。同一个修复动作出现两次是更差的
 * 体验，所以本卡只负责指出“卡在哪一环”。
 */
export function StatusCard({
  status,
  displayHost,
  port,
  onChanged,
  onNavigate,
}: {
  /** 不含高频字段（uptime / stats 由本组件自己订阅）。 */
  status?: StaticStatus;
  displayHost: string;
  port: number;
  onChanged: () => void;
  /**
   * 跨 Tab 跳转。本卡**不整卡可点**——卡内已有停止/重启按钮与「查看全部」链接，
   * 整卡可点会让点按钮顺便跳页。只把链路三段做成可点。
   */
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const { data: live } = useQuery<StatusResponse, Error, LiveStatus>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    select: (s) => ({ uptimeSeconds: s.uptimeSeconds, stats: s.stats }),
  });

  const running = status?.running ?? false;
  const { lastIncreaseAt } = useRemoteActivity();

  // 运行时长本地每秒自增，5s 轮询回来时以后端为准校准，实现平滑跳秒。
  const [liveUptime, setLiveUptime] = useState(0);
  const uptimeSeconds = live?.uptimeSeconds;
  const appHidden = useAppHidden();
  useEffect(() => {
    if (uptimeSeconds == null || !running) return;
    setLiveUptime(uptimeSeconds);
    // 窗口不可见时不跳秒：每秒一次 setState 会驱动整张卡重渲，而没人在看。
    if (appHidden) return;
    const timer = setInterval(() => setLiveUptime((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [uptimeSeconds, running, appHidden]);

  // 启停 / 重启的过渡态与失败内联报错。
  const [pending, setPending] = useState<"toggle" | "restart" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();

  const toggleServer = async () => {
    setErr(null);
    setPending("toggle");
    try {
      await invoke(running ? "stop_mcp_server" : "start_mcp_server");
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setPending(null);
    }
  };

  // 重启 = 串行的停 + 启。不并发：端口释放前就重新绑定会报“地址已被使用”。
  //
  // 为何只有重启需要兜最短时长与 toast（启/停不需要）：
  // 启停成功后卡片基调会整张变色、文案也换，本身就是很强的反馈；
  // 重启成功后卡片外观**完全不变**，唯一线索是右上角小字变回「已运行 0秒」。
  const restartServer = async () => {
    setErr(null);
    setPending("restart");
    const startedAt = Date.now();
    let ok = false;
    try {
      await invoke("stop_mcp_server");
      await invoke("start_mcp_server");
      onChanged();
      ok = true;
    } catch (e) {
      setErr(String(e));
    }
    const rest = MIN_PENDING_MS - (Date.now() - startedAt);
    if (rest > 0) await sleep(rest);
    setPending(null);
    // 失败不弹 toast：卡内已经有报错块而且会震一下（animate-shake），再弹一次是重复。
    if (ok) toast("服务已重启", "success");
  };

  const chain = computeChain({
    running,
    startupError: status?.startupError ?? null,
    remoteReachable: status?.remoteReachable ?? false,
    platform: status?.platform,
    firewallPortOpen: status?.firewallPortOpen,
    firewallAvailable: status?.firewallAvailable,
    totalRequests: live?.stats.totalRequests ?? 0,
    lastIncreaseAt,
    now: Date.now(),
    port,
  });

  const busy = pending !== null;
  // 基调真的变了时播一次淡入（400ms）。
  // 为何不用 `transition: background`：linear-gradient 不是可插值属性，写了也是硬切。
  const toneSwitch = useChangeClass(chain.tone, "status-card--switch", 400);

  return (
    <div className={`status-card ${TONE_CLASS[chain.tone]} ${toneSwitch}`}>
      <div className="flex items-center text-[9.5px] font-bold uppercase tracking-[0.12em] opacity-90">
        服务状态
        <span className="ml-auto text-[10px] font-semibold normal-case tracking-normal">
          {running ? `已运行 ${formatUptime(liveUptime)}` : "未运行"}
        </span>
      </div>

      <div className="my-3.5">
        <ServiceChain segments={chain.segments} onNavigate={onNavigate} platform={status?.platform} />
      </div>

      <p className="text-[13.5px] font-bold leading-normal">{chain.headline}</p>
      {/* break-all：startupError 可能是很长的系统错误串，不断行会撑破窄卡。 */}
      <p className="mt-1 break-all text-[11px] leading-relaxed opacity-90">{chain.sub}</p>

      {status && running && (
        // 传输 / Bearer 并进地址行。它俩原来各占一行，而「HTTP 传输 · Bearer 已启用」
        // 这句话在正常态几乎永远不变，不值一整行（本卡跨两行，它的高度直接决定
        // 右侧六张卡的行高）。
        //
        // truncate 的降级方向正好是对的：宽度不够时先吃掉尾部的元信息，
        // 地址（用户要复制的那串）保住。所以不需要拆 flex 子项去控优先级。
        <div className="mt-3 truncate rounded-lg bg-white/[0.14] px-2.5 py-1.5 font-mono text-[11.5px]">
          {displayHost} : {port}
          {/* 元信息不跟 font-mono：等宽字体下 CJK 既偏宽也难看（与最近活动同一理由）。
              顺带也拉开了层次：地址是等宽的数据，后面两项是标签。 */}
          <span className="font-sans opacity-85">
            {" · "}
            {(status.transport ?? "http").toUpperCase()}
            {status.token ? " · Bearer" : " · 未设 Bearer"}
          </span>
        </div>
      )}

      {status && (
        <StopClick className="mt-3 flex gap-2">
          {/* --grow / ghost 的下限宽都在 index.css：两颗按钮的宽度不能跟文字长度走。 */}
          <Button onClick={toggleServer} disabled={busy} className="status-btn status-btn--grow">
            {pending === "toggle" ? (
              <Icon name="spinner" size={14} className="animate-spin" />
            ) : (
              <Icon name={running ? "pause" : "play"} size={14} />
            )}
            {pending === "toggle" ? (running ? "停止中…" : "启动中…") : running ? "停止服务" : "启动服务"}
          </Button>
          {/* 未运行时禁用：没在跑的东西谈不上重启，该点的是旁边那颗启动。 */}
          <Button
            onClick={restartServer}
            disabled={busy || !running}
            className="status-btn status-btn--ghost"
          >
            {pending === "restart" ? (
              <Icon name="spinner" size={14} className="animate-spin" />
            ) : (
              <Icon name="refresh" size={14} />
            )}
            {pending === "restart" ? "重启中…" : "重启"}
          </Button>
        </StopClick>
      )}

      {err && (
        // animate-shake：启停失败是需要被看见的事，震一下比默默出现有效。一次性动画。
        <div className="animate-shake mt-2 flex items-start gap-1.5 rounded-lg border border-white/25 bg-black/25 px-2.5 py-1.5 text-[11.5px]">
          <Icon name="alertTriangle" size={13} className="mt-px shrink-0" />
          <span className="break-all">{err}</span>
        </div>
      )}

      <RecentActivity onViewAll={onNavigate ? () => onNavigate("log") : undefined} />
    </div>
  );
}
