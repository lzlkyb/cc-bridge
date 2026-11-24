import type { ReactNode } from "react";
import { formatClock, formatInt, formatMs, rewriteLabel } from "../../lib/relayFormat";
import { actualModel, dayKey, estimateCost, isPending, isRelayError, moneyLabel, providerLabel, rateKey, relayOutcome, relayUsageState, TOKEN_FIELDS, tokenTotal, type RelayRates } from "../../lib/relayUsage";
import type { RelayLogEntry } from "../../lib/types";
import { tierLabel } from "./RelayRequestTable";

function Info({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

export function RelayRequestDetails({ row, rates, onPricing }: { row: RelayLogEntry; rates: RelayRates; onPricing: () => void }) {
  const result = relayOutcome(row);
  const priceKey = rateKey(row);
  const price = priceKey ? rates[priceKey] : undefined;
  const amount = estimateCost(row, rates);
  const total = tokenTotal(row.usage);
  return <>
    <div className="relay-inline relay-wrap relay-spread"><span className="relay-work-badge" data-tone={result.tone}>{result.label}</span><small>{dayKey(row.tsMs)} {formatClock(row.tsMs)}</small></div>
    {isRelayError(row) && <div className="relay-work-notice" role="status">
      <strong>{row.error || `上游返回 HTTP ${row.status}`}</strong>
      {row.status === 429 && <span>等待额度恢复，或到上游控制台查看限流情况。</span>}
      {(row.status === 401 || row.status === 403) && <span>检查上游密钥和鉴权方式。也请确认客户端中转令牌仍有效。</span>}
      {row.status === 404 && <span>检查上游地址和模型名。</span>}
    </div>}
    <section className="relay-detail-section"><h3>请求路由</h3><dl>
      <Info label="客户端模型">{row.clientModel || "—"}</Info>
      <Info label="实际模型">{actualModel(row) || "—"}</Info>
      {row.reportedModel && row.reportedModel !== row.upstreamModel && <Info label="转发模型名">{row.upstreamModel}</Info>}
      <Info label="映射档位">{tierLabel(row.tier)}{row.fellBack && " → 默认档"}</Info>
      <Info label="上游供应商">{providerLabel(row.upstreamProvider, row.upstreamKey)}</Info>
      <Info label="来源">{row.source === "local" ? "回环" : `内网 · ${row.source}`}</Info>
      <Info label="请求路径">{row.path}</Info>
      <Info label="HTTP 状态">{row.status ?? "—"}</Info>
      <Info label="首字耗时">{formatMs(row.firstByteMs)}</Info>
      <Info label="请求改写">{rewriteLabel(row.rewrite) || "无"}</Info>
      {row.foldSummary && <Info label="折叠摘要">{row.foldSummary}</Info>}
    </dl></section>
    <section className="relay-detail-section">
      <div className="relay-inline relay-spread"><h3>Token 用量</h3><span className="relay-work-badge" data-tone={row.usage?.partial ? "warn" : row.usage ? "ok" : "mute"}>{relayUsageState(row)}</span></div>
      <div className="relay-detail-total">{total == null ? "—" : formatInt(total)}{total != null && <small> Token</small>}</div>
      <dl>{TOKEN_FIELDS.map(({ key, label }) => { const value = row.usage?.[key]; return <Info key={key} label={label}>{value == null ? "—" : formatInt(value)}</Info>; })}</dl>
      <small>{row.usage?.partial ? "仅包含已收到的用量字段。" : row.usage ? "总 Token 包含全部输入、缓存与输出。" : isPending(row) ? "请求结束后会读取上游返回的用量。" : row.usageCollectionIssue ? relayUsageState(row) : "当前记录没有可计入汇总的上报用量。"}</small>
    </section>
    <section className="relay-detail-section">
      <div className="relay-inline relay-spread"><h3>预估费用</h3>{priceKey && row.usage && <button type="button" className="relay-text-button" onClick={onPricing}>配置单价</button>}</div>
      <dl><Info label="合计">{amount != null ? `${moneyLabel(amount)} USD` : row.usage?.partial ? "用量未采全" : row.usage && priceKey ? "待配置单价" : "—"}</Info></dl>
      {price && <details><summary>查看费率（USD / 百万 Token）</summary><dl>{TOKEN_FIELDS.map(({ key, label }) => <Info key={key} label={label}>{moneyLabel(price[key])}</Info>)}</dl></details>}
    </section>
  </>;
}
