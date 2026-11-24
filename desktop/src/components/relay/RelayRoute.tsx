import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";
import { useToast } from "../ui/toast";
import { useAppHidden } from "../../lib/appVisibility";
import { copyText } from "../../lib/utils";
import { formatInt, formatMs, rewriteLabel } from "../../lib/relayFormat";
import { actualModel, isGeneration, isRelayError, providerLabel, relayKey, summarizeUsage } from "../../lib/relayUsage";
import type { RelayLogEntry, RelaySnapshot } from "../../lib/types";
import { tierLabel } from "./RelayRequestTable";
import { compactTokens } from "./RelayUsageChart";
import { RelayMetric } from "./RelayUsageView";

function RouteNode({ icon, label, value, sub, core, selected }: {
  icon: IconName; label: string; value: string; sub: string; core?: boolean; selected?: boolean;
}) {
  return <div className="relay-route-node" data-core={core || undefined} data-selected={selected || undefined}>
    <span className="relay-route-symbol"><Icon name={icon} size={21} /></span>
    <div><small>{label}</small><strong title={value}>{value}</strong><small title={sub}>{sub}</small></div>
  </div>;
}

function RouteLink({ label, inactive, pulse }: { label: string; inactive: boolean; pulse: string | null }) {
  return <div className="relay-route-link" data-inactive={inactive || undefined} aria-hidden="true"><span>{label}</span>
    {pulse && !inactive && <i key={pulse} />}
  </div>;
}

export function RelayRoute({ snapshot, todayRows, selected, busy, onClear, onUsage }: {
  snapshot: RelaySnapshot;
  todayRows: RelayLogEntry[];
  selected?: RelayLogEntry;
  busy: boolean;
  onClear: () => void;
  onUsage: () => void;
}) {
  const { toast } = useToast();
  const hidden = useAppHidden();
  const [pulse, setPulse] = useState<string | null>(null);
  const completed = snapshot.recent.find((row) => isGeneration(row) && row.status != null && row.status >= 200 && row.status < 300 && !row.error);
  const eventKey = completed ? relayKey(completed) : null;
  const previous = useRef(eventKey);
  useEffect(() => {
    if (hidden) {
      previous.current = eventKey;
      setPulse(null);
      return;
    }
    if (eventKey === previous.current) return;
    previous.current = eventKey;
    setPulse(eventKey);
  }, [eventKey, hidden]);

  const defaultTier = snapshot.tiers.find((tier) => tier.tier === "default");
  const configured = snapshot.provider?.configured ?? false;
  const fallbackTiers = snapshot.tiers.filter((tier) => tier.tier !== "default" && !tier.configured).map((tier) => tierLabel(tier.tier));
  const direct = snapshot.listenHost !== "127.0.0.1";
  const inactive = busy || !snapshot.running || !configured;
  const { usage, failures, p50 } = useMemo(() => {
    const latencies = todayRows.flatMap((row) => row.firstByteMs == null ? [] : [row.firstByteMs]).sort((a, b) => a - b);
    return { usage: summarizeUsage(todayRows.filter(isGeneration)), failures: todayRows.filter(isRelayError).length,
      p50: latencies[Math.round((latencies.length - 1) / 2)] };
  }, [todayRows]);
  const copyAlias = (alias: string) => void copyText(alias, () => toast("客户端模型名已复制", "success"), () => toast("复制失败，请手动选中复制", "error"));

  return <section className="relay-work-panel" aria-labelledby="relay-route-heading">
    <header className="relay-section-head">
      <div><h2 id="relay-route-heading">模型路由</h2><p>{selected ? `正在查看 ${selected.clientModel || "这条请求"} 的实际转发路径。` : "客户端模型名经映射后，发往实际的上游模型。"}</p></div>
      <div className="relay-inline relay-wrap">
        {selected && <button type="button" className="relay-text-button" onClick={onClear}>清除选中</button>}
        <span className="relay-work-badge" data-tone={direct ? "warn" : "accent"}>{direct ? "内网直连" : "SSH 隧道"}</span>
      </div>
    </header>
    <div className="relay-route-body">
      <div className="relay-route-rail">
        <RouteNode icon="terminal" label="客户端" value={selected?.clientModel || "Claude Code"}
          sub={selected ? (selected.source === "local" ? "请求模型 · 回环" : "请求模型 · 内网") : configured && defaultTier ? `请求模型 · ${defaultTier.alias}` : "等待配置"} selected={Boolean(selected)} />
        <RouteLink label="请求进入" inactive={inactive} pulse={hidden ? null : pulse} />
        <RouteNode icon="gitBranch" label="CC Bridge 中转" core selected={Boolean(selected)}
          value={selected ? `${tierLabel(selected.tier)}${selected.fellBack ? " → 默认档" : ""}` : "模型映射"}
          sub={selected ? rewriteLabel(selected.rewrite) ?? "原样转发" : "默认档 · Haiku · Opus"} />
        <RouteLink label="映射转发" inactive={inactive} pulse={hidden ? null : pulse} />
        <RouteNode icon="server" label="上游模型" value={selected ? actualModel(selected) || "未到达上游" : defaultTier?.upstreamModel || "待配置"}
          sub={selected ? providerLabel(selected.upstreamProvider) : configured ? snapshot.provider?.name || "上游" : "填写地址、密钥和模型"} selected={Boolean(selected)} />
      </div>
      {snapshot.tiers.length > 0 && <details className="relay-mapping">
        <summary><Icon name="chevronRight" size={13} />查看档位映射 {configured && fallbackTiers.length > 0 && <small>{fallbackTiers.join("、")} 使用默认档</small>}</summary>
        <div className="relay-mapping-list">
          {snapshot.tiers.map((tier) => <div key={tier.tier}>
            <div className="relay-inline relay-spread"><strong>{tierLabel(tier.tier)}</strong>
              {configured && <Button size="sm" variant="ghost" aria-label={`复制 ${tierLabel(tier.tier)} 客户端模型名`} onClick={() => copyAlias(tier.alias)}><Icon name="copy" size={13} /></Button>}
            </div>
            <code title={tier.alias}>{tier.alias}</code><small title={tier.upstreamModel}>{tier.upstreamModel || (configured ? "使用默认档" : "待配置")}</small>
          </div>)}
        </div>
      </details>}
    </div>
    <dl className="relay-work-metrics">
      <RelayMetric label="处理中" value={snapshot.running ? formatInt(snapshot.stats.inFlight) : "—"} note={snapshot.running ? "条" : undefined} />
      <RelayMetric label="今日请求" value={formatInt(todayRows.length)} note="次" />
      <RelayMetric label="今日异常" value={formatInt(failures)} note="条" />
      <RelayMetric label="首字 P50" value={formatMs(p50)} />
      <div className="relay-work-metric relay-metric-link"><dt><button className="relay-text-button" type="button" onClick={onUsage}>今日 Token <Icon name="chevronRight" size={13} /></button></dt><dd>{compactTokens(usage.total)}{usage.partial > 0 && <small>部分采集</small>}</dd></div>
    </dl>
  </section>;
}
