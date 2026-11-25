import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { formatClock, formatInt, formatMs } from "../../lib/relayFormat";
import { actualModel, dayKey, estimateCost, moneyLabel, requestProviderLabel, rateKey, relayKey, relayOutcome, relayUsageState, shortRelayDay, tokenTotal, type RelayRates } from "../../lib/relayUsage";
import type { RelayLogEntry } from "../../lib/types";

const PER_PAGE = 5;

export function tierLabel(tier: string) {
  return tier === "default" ? "默认档" : tier === "haiku" ? "Haiku" : tier === "opus" ? "Opus" : tier || "—";
}

function tokenCost(row: RelayLogEntry, rates: RelayRates) {
  const amount = estimateCost(row, rates);
  if (amount != null) return moneyLabel(amount);
  if (!row.usage) return "—";
  if (row.usage.partial) return "部分采集";
  return rateKey(row) ? "待配置单价" : "—";
}

export function RelayRequestTable({ rows, usage = false, dated = usage, rates, selected, onRequest, empty, requestedPage, onPage }: {
  rows: RelayLogEntry[];
  usage?: boolean;
  dated?: boolean;
  rates: RelayRates;
  selected?: string | null;
  onRequest: (row: RelayLogEntry) => void;
  empty: React.ReactNode;
  requestedPage: number;
  onPage: (next: number) => void;
}) {
  if (!rows.length) return <div className="relay-table-empty">{empty}</div>;

  const pages = Math.ceil(rows.length / PER_PAGE);
  const page = Math.min(requestedPage, pages - 1);
  const start = page * PER_PAGE;
  const visible = rows.slice(start, start + PER_PAGE);
  return (
    <>
      <div className="relay-work-table-scroll" tabIndex={0} role="region" aria-label={usage ? "逐请求用量表" : "请求记录表"}>
        <table className="relay-work-table">
          <thead><tr>
            <th scope="col">时间</th><th scope="col">{usage ? "实际模型" : "请求模型 → 实际模型"}</th>
            {!usage && <><th scope="col">请求结果</th><th scope="col">来源</th><th scope="col" className="relay-number">首字耗时</th></>}
            <th scope="col" className="relay-number">总 Token</th>
            {usage && <><th scope="col" className="relay-number">预估费用</th><th scope="col">请求结果</th></>}
            <th scope="col"><span className="sr-only">详情</span></th>
          </tr></thead>
          <tbody>{visible.map((row) => {
            const key = relayKey(row);
            const result = relayOutcome(row);
            const model = actualModel(row) || "—";
            const token = tokenTotal(row.usage);
            const resultBadge = <span className="relay-work-badge" data-tone={result.tone}>{result.label}</span>;
            return <tr key={key} data-selected={key === selected || undefined} onClick={(event) => {
              event.currentTarget.querySelector("button")?.focus({ preventScroll: true });
              onRequest(row);
            }}>
              <td className="tabular-nums">{dated && `${shortRelayDay(dayKey(row.tsMs))} `}{formatClock(row.tsMs)}</td>
              <td className="relay-work-model" title={`${row.clientModel} → ${model}`}>
                <strong>{!usage && row.clientModel && row.clientModel !== model ? `${row.clientModel} → ${model}` : model}</strong>
                <small>{requestProviderLabel(row)} · {row.fellBack ? `${tierLabel(row.tier)} 回落到默认档` : tierLabel(row.tier)}</small>
              </td>
              {!usage && <><td>{resultBadge}</td><td title={row.source === "local" ? undefined : row.source}>{row.source === "local" ? "回环" : "内网"}</td>
                <td className="relay-number">{formatMs(row.firstByteMs)}</td></>}
              <td className="relay-number" title={relayUsageState(row)}>{token == null ? "—" : formatInt(token)}{row.usage?.partial && <small> 部分</small>}</td>
              {usage && <><td className="relay-number">{tokenCost(row, rates)}</td><td>{resultBadge}</td></>}
              <td><Button size="sm" variant="ghost" type="button" aria-label={`查看 ${formatClock(row.tsMs)} ${model} 请求详情`}
                onClick={(event) => { event.stopPropagation(); onRequest(row); }}><Icon name="chevronRight" size={14} /></Button></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="relay-table-foot">
        <span>{start + 1}–{start + visible.length} / {formatInt(rows.length)} 条</span>
        {pages > 1 && <div className="relay-inline">
          <Button size="sm" variant="ghost" aria-label="上一页" disabled={!page} onClick={() => onPage(page - 1)}><Icon name="chevronLeft" size={14} /></Button>
          <span>{page + 1} / {pages}</span>
          <Button size="sm" variant="ghost" aria-label="下一页" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}><Icon name="chevronRight" size={14} /></Button>
        </div>}
      </div>
    </>
  );
}
