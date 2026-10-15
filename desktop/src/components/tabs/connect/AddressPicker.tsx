import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../../lib/tauri";
import type { LanProbeItem, LanProbeState } from "../../../lib/types";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { ipHint } from "../../../lib/utils";
import { useCopyFeedback } from "../../../hooks/useCopyFeedback";

/** 探测三态角标的文案与配色（bg/色值走语义 token，亮暗主题自动跟随）。 */
const PROBE_BADGE: Record<LanProbeState, { label: string; className: string }> = {
  ok: { label: "✓ 通", className: "bg-success/15 text-success-ink" },
  fail: { label: "× 不通", className: "bg-destructive/12 text-destructive-ink" },
  unknown: { label: "？未定", className: "bg-muted-foreground/14 text-muted-foreground" },
};

const PROBE_TITLE: Record<LanProbeState, string> = {
  ok: "本机探测：该地址端口可达",
  fail: "本机探测：连接被拒绝（服务可能未监听该地址）",
  unknown: "本机探测：超时或未知，无法判定（如防火墙拦本机自连）",
};

/**
 * 多网卡时让用户选「远程服务器能连回本机的地址」，并附连通自检命令。
 *
 * 评审修复 ④：桥跑在本机，对每个 lanIp:port 发起 TCP 探测零成本——此前却让用户
 * 「拿不准就逐个试，或 ssh 上服务器验证」。现在 Rust 侧 probe_lan_ips 并发探测
 * （800ms 超时，三态诚实兜底），IP 卡右上角标出 通/不通/未定：
 * - 默认选中自动落到第一个「通」的地址（仅当当前选中还是朴素默认的第一个 IP 时，
 *   绝不覆盖用户确认过的地址）；
 * - 全部「未定」时退回现状：第一个 IP + 「默认」徽章，不谎报；
 * - 「刷新地址」按钮改为同时触发探测 refetch——顺带把原固定 800ms 的假 spinner
 *   修成跟随真实请求的 spinner。
 */
export function AddressPicker({
  ips,
  selected,
  onSelect,
  healthCheck,
  port,
  onRefresh,
}: {
  ips: string[];
  selected: string;
  onSelect: (ip: string) => void;
  healthCheck: string;
  /** 探测目标端口（桥监听端口），与 status.port 同源。 */
  port: number;
  onRefresh?: () => void;
}) {
  // 复制反馈统一走 useCopyFeedback（评审修复 ⑤）。
  const fb = useCopyFeedback();
  // 本机探测：目标仅限本机网卡地址（不新增外部连接面），30s 内复用缓存。
  const { data: probe, refetch, isFetching } = useQuery<LanProbeItem[]>({
    queryKey: ["lan-probe", port],
    queryFn: () => invoke<LanProbeItem[]>("probe_lan_ips", { port }),
    staleTime: 30_000,
  });

  // 默认选中落「通」：只在探测结果首次到达时应用一次，且仅当当前选中还是朴素默认
  // （第一个 IP，由 ConnectTab 的场景 1 自动选中）时才切换——用户已确认过的地址
  // （后端 last_selected_ip 或手动改选）绝不静默覆盖。
  const probeAppliedRef = useRef(false);
  useEffect(() => {
    if (!probe || probeAppliedRef.current) return;
    probeAppliedRef.current = true;
    const okIp = ips.find((ip) => probe.some((p) => p.ip === ip && p.state === "ok"));
    if (okIp && okIp !== selected && selected === ips[0]) onSelect(okIp);
  }, [probe, ips, selected, onSelect]);

  // 角标模式：探测数据缺失或全部「未定」→ 维持现状（第一个 + 「默认」徽章），不谎报。
  const probeUsable =
    !!probe && probe.some((p) => ips.includes(p.ip) && p.state !== "unknown");

  const copyHealth = () => {
    if (!healthCheck) return;
    fb.copy("health", healthCheck);
  };

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">选择远程服务器能连回本机的地址</p>
          <p className="text-xs text-muted-foreground mt-1">
            <Icon name="plug" size={13} className="inline-block align-[-2px] mr-1" aria-hidden="true" /> 通过 <b>VPN</b> 连服务器 → 选 VPN 网段（多为 10.x）；
            <Icon name="monitor" size={13} className="inline-block align-[-2px] mr-1" aria-hidden="true" /> <b>内网直连</b> → 选内网 IP（192.168.x / 172.x）。
            角标是<b>本机探测</b>结果：<b className="text-success-ink">通</b> = 该地址端口可达；
            全部「未定」时维持原「默认」推荐。若远程与本机不在同一网络，用下方命令在服务器上二次确认。
          </p>
        </div>
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              void refetch();
              onRefresh();
            }}
          >
            <Icon name="refresh" size={14} className={isFetching ? "animate-spin" : ""} />
            {isFetching ? "探测中" : "刷新地址"}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {ips.map((ip, i) => {
          const sel = selected === ip;
          const item = probe?.find((p) => p.ip === ip);
          const st = item?.state;
          const badge = st ? PROBE_BADGE[st] : undefined;
          return (
            <button
              key={ip}
              onClick={() => onSelect(ip)}
              title={
                st
                  ? `${PROBE_TITLE[st]}${item?.ms != null ? `（${item.ms}ms）` : ""}`
                  : isFetching
                    ? "本机探测中…"
                    : undefined
              }
              className={`relative rounded-md border-2 px-3 py-2 text-left transition-colors ${
                sel
                  ? "border-primary bg-accent shadow-ring-focus"
                  : "border-transparent bg-background hover:bg-muted"
              }`}
            >
              {/* 选中角标与探测角标同占右上角：有探测结论时角标本身就是更强的选中信号
                  （边框高亮 + IP 变色仍在），让位给通/不通的结论；无结论时保留对勾。 */}
              {sel && !badge && (
                <span className="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Icon name="check" size={10} />
                </span>
              )}
              {badge && (
                <span
                  className={`absolute right-1.5 top-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-bold leading-none ${badge.className}`}
                >
                  {badge.label}
                </span>
              )}
              <div className="flex items-center gap-2">
                <code className={`text-sm font-mono ${sel ? "text-primary" : ""}`}>{ip}</code>
                {!probeUsable && i === 0 && <Badge variant="secondary">默认</Badge>}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{ipHint(ip)}</p>
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5 pt-1">
        <p className="text-xs text-muted-foreground">
          在服务器上执行以下命令验证连通（返回 {"{"}"status":"ok"{"}"} 即可用该 IP）：
        </p>
        <div className="flex flex-wrap items-start gap-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md bg-background border px-3 py-2 text-xs font-mono">
            {healthCheck}
          </code>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={copyHealth}
            disabled={!healthCheck}
            aria-live="polite"
          >
            <Icon name={fb.isCopied("health") ? "check" : "copy"} size={14} />
            {fb.isCopied("health") ? "已复制" : "复制"}
          </Button>
        </div>
      </div>
    </div>
  );
}
