import { formatInt } from "../../lib/relayFormat";
import { dayKey, shiftDay, shortRelayDay, summarizeUsage, TOKEN_FIELDS } from "../../lib/relayUsage";
import type { RelayLogEntry } from "../../lib/types";

export function compactTokens(value: number | null) {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}K`;
  return formatInt(value);
}

export function bucketKey(row: RelayLogEntry, hours: boolean) {
  const day = dayKey(row.tsMs);
  return hours ? `${day}T${Math.floor(new Date(row.tsMs).getHours() / 4) * 4}` : day;
}

export function bucketLabel(key: string) {
  const [day, hour] = key.split("T");
  return hour == null ? shortRelayDay(day) : `${hour.padStart(2, "0")}:00`;
}

export function RelayUsageChart({ rows, from, to, selected, onSelect }: {
  rows: RelayLogEntry[];
  from: string;
  to: string;
  selected: string | null;
  onSelect: (bucket: string) => void;
}) {
  const hours = from === to;
  const buckets = new Map<string, RelayLogEntry[]>();
  if (hours) {
    for (let hour = 0; hour < 24; hour += 4) buckets.set(`${from}T${hour}`, []);
  } else {
    for (let date = from; date <= to; date = shiftDay(date, 1)) buckets.set(date, []);
  }
  for (const row of rows) buckets.get(bucketKey(row, hours))?.push(row);
  const points = Array.from(buckets, ([id, entries]) => ({ id, requests: entries.length, ...summarizeUsage(entries) }));
  const max = Math.max(0, ...points.map((point) => point.total ?? 0));
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(40, max) / 4)));
  const step = ([1, 2, 2.5, 5, 10].find((n) => n * magnitude * 4 >= max) ?? 10) * magnitude;
  const ceiling = step * 4;
  return (
    <div className="relay-usage-analysis-panel">
      <div className="relay-inline relay-spread"><h3>用量趋势</h3><small>{points.some((point) => point.covered) ? "点击柱状图筛选请求" : "当前范围无可用 Token"}</small></div>
      <div className="relay-chart">
        <div className="relay-chart-axis" aria-hidden="true">{[4, 3, 2, 1, 0].map((n) => <span key={n}>{compactTokens(n * step)}</span>)}</div>
        <div className="relay-chart-columns">
          {points.map((point) => {
            const label = bucketLabel(point.id);
            const hint = `${label} · ${point.total == null ? "无可用用量" : `${formatInt(point.total)} Token`} · ${point.requests} 条请求`;
            return <button key={point.id} type="button" className="relay-chart-day" aria-pressed={selected === point.id} title={hint} aria-label={hint} onClick={() => onSelect(point.id)}>
              <span className="relay-chart-stack" aria-hidden="true">
                {TOKEN_FIELDS.map(({ key }) => <i key={key} data-count={key} style={{ height: `${(point.counts[key] ?? 0) / ceiling * 100}%` }} />)}
              </span><span>{label}</span>
            </button>;
          })}
        </div>
      </div>
      <div className="relay-chart-legend">{TOKEN_FIELDS.map(({ key, label }) => <span key={key}><i data-count={key} />{label}</span>)}</div>
    </div>
  );
}
