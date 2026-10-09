import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, StaticStatus, LiveStatus } from "../../lib/types";
import { useCountUp } from "../../hooks/useCountUp";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { usePopClass } from "../../hooks/useChangeClass";
import { NavTarget, StopClick } from "../ui/NavTarget";
import { Icon } from "../ui/icon";

/**
 * Bento 行2 的「健康度 · 安全治理」合并卡（4/12 列）。
 *
 * 原为两张独立卡（HealthCard + GovCard）。Token 用量卡加入行2 后 8 列要分给
 * 三张卡（3+3+2），治理卡 9 个胶囊被压到 2 列会过度换行；按设计稿方案 B 把
 * 治理胶囊整体下沉到健康卡下半部（健康卡本来就有 flex-1 富余吃高度），
 * 行2 变成 合并卡(4) + 用量卡(4)，网格维持 4+4+4=12。
 *
 * 整卡可点 → 日志页：成功率 / 失败数 / 审计明细在那边。九个胶囊各自跳对应
 * 设置项，用 StopClick 阻断冒泡（点胶囊不得触发整卡跳日志页）。
 */

/** 九个治理胶囊各自的跳转目标（anchor 全部取自 lib/settingsSearch.ts，勿另起一套）。 */
const NAV = {
  roots: { tab: "security", title: "去安全页管理白名单目录" },
  audit: { tab: "settings", anchor: "audit", title: "去设置调整审计日志" },
  ratelimit: { tab: "settings", anchor: "ratelimit", title: "去设置调整限流" },
  backup: { tab: "settings", anchor: "backup", title: "去设置调整写备份" },
  encoding: { tab: "settings", anchor: "encoding", title: "去设置调整读取编码自适应" },
  readonly: { tab: "settings", anchor: "readonly", title: "去设置调整只读模式" },
  shell: { tab: "settings", anchor: "shell", title: "去设置调整命令执行" },
  session: { tab: "settings", anchor: "session-persist", title: "去设置调整命令会话持久化" },
} as const;

/** 健康度 + 安全治理：环 + 成功率 + 四道防线胶囊。 */
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

  // 入场数字滚动（仅首次挂载，后续 5s 轮询直接跟随终值）。JS 驱动的动画
  // CSS 全局兜底管不到，所以要自己查 reduced-motion。
  const reduced = usePrefersReducedMotion();
  const rateAnim = useCountUp(rate, { enabled: running && !reduced, duration: 900 });
  const rateText = running ? `成功率 ${rateAnim.toFixed(1)}%` : "服务未运行";
  const ratePop = usePopClass(rateText);

  // 「推荐状态 ✓」只在四道基础防线全开时给——不能因为「大部分开了」就撞绿。
  const roots = status?.allowedRoots.length ?? 0;
  const windowSec = Math.round((status?.rateLimit.windowMs ?? 0) / 1000);
  const recommended =
    !!status?.whitelistEnabled &&
    !!status?.auditEnabled &&
    !!status?.rateLimitEnabled &&
    !!status?.backupEnabled;

  // status 未就绪（冷启动首帧）渲染占位空卡，占住网格位（原 GovCard 行为）。
  if (!status) return <div className="bento-card" />;

  return (
    <NavTarget
      onNavigate={onNavigate}
      tab="log"
      title="去日志页看调用明细与错误"
      className="bento-card"
    >
      <div className="bento-eyebrow">
        健康度 · 安全治理
        <span
          className={`ml-auto text-[10px] font-bold normal-case tracking-normal ${
            recommended ? "text-success" : "text-warning"
          }`}
        >
          {recommended ? "推荐状态 ✓" : "有防线未开"}
        </span>
      </div>

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

      {/* 治理胶囊。mt-auto + content-end 吃掉网格摊过来的多余高度（行2 的高度由
          跨两行的状态卡反推）。🔴 StopClick 必需：胶囊嵌在整卡可点的 NavTarget 里，
          不阻断冒泡的话点胶囊会顺带跳去日志页（见 NavTarget.StopClick 注释）。 */}
      <StopClick className="mt-auto flex flex-1 flex-wrap content-end gap-1.5 pt-3">
        <Pill
          on={status.whitelistEnabled}
          text={`路径白名单 · ${roots} 目录`}
          onNavigate={onNavigate}
          {...NAV.roots}
        />
        <Pill on={status.auditEnabled} text="审计日志" onNavigate={onNavigate} {...NAV.audit} />
        <Pill
          on={status.rateLimitEnabled}
          text={`限流 ${status.rateLimit.maxRequests}次/${windowSec}秒`}
          onNavigate={onNavigate}
          {...NAV.ratelimit}
        />
        <Pill
          on={status.backupEnabled}
          text={`写备份 ${status.backupCount} 份`}
          onNavigate={onNavigate}
          {...NAV.backup}
        />
        <Pill
          on={status.encodingDetectEnabled}
          text="编码探测"
          onNavigate={onNavigate}
          {...NAV.encoding}
        />
        {/* 备份保留份数：纯配置值，不是开关，所以永远中性色。 */}
        <Pill
          on={false}
          text={`每文件保留 ${status.backupRetention} 份`}
          onNavigate={onNavigate}
          {...NAV.backup}
        />
        {/* 下三项是「开了才需要留神」的项：传进去的 on 已取过反，
            配上 warnWhenOn 后——开启时报警色，关闭是中性。 */}
        <Pill
          on={!status.readonlyMode}
          warnWhenOn
          text={`只读模式 ${status.readonlyMode ? "开" : "关"}`}
          onNavigate={onNavigate}
          {...NAV.readonly}
        />
        <Pill
          on={!status.shellEnabled}
          warnWhenOn
          text={`命令执行 ${status.shellEnabled ? `开 · ${status.shellType}` : "关"}`}
          onNavigate={onNavigate}
          {...NAV.shell}
        />
        <Pill
          on={!status.sessionCwdEnabled}
          warnWhenOn
          text={`会话持久化 ${status.sessionCwdEnabled ? "开" : "关"}`}
          onNavigate={onNavigate}
          {...NAV.session}
        />
      </StopClick>
    </NavTarget>
  );
}

/**
 * 治理胶囊。
 *
 * `on=true` → 绿色带 ✓；`on=false` → 中性灰。
 * `warnWhenOn` 用于「只读模式 / 命令执行」这种反语义项：传进来的 `on` 已经取过反，
 * false 意味着「该留神的项被打开了」，此时用警色而不是灰色。
 */
function Pill({
  on,
  text,
  warnWhenOn,
  onNavigate,
  tab,
  anchor,
  title,
}: {
  on: boolean;
  text: string;
  warnWhenOn?: boolean;
  onNavigate?: (tab: string, anchor?: string) => void;
  tab: string;
  anchor?: string;
  title: string;
}) {
  const cls = on ? "gov-pill gov-pill--ok" : warnWhenOn ? "gov-pill gov-pill--warn" : "gov-pill";
  return (
    <NavTarget onNavigate={onNavigate} tab={tab} anchor={anchor} title={title} className={cls}>
      {on && <Icon name="check" size={11} />}
      {text}
    </NavTarget>
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
