import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { Modal } from "../ui/Modal";
import { exportedToast, saveTextExport } from "../../lib/exportFile";
import { formatInt } from "../../lib/relayFormat";
import { actualModel, dayKey, isGeneration, isPending, moneyLabel, providerKey, providerLabel, relayUsageCsv, shiftDay, shortRelayDay, summarizeUsage, TOKEN_FIELDS, tokenTotal, type RelayRates } from "../../lib/relayUsage";
import type { RelayLogEntry } from "../../lib/types";
import { RelayRequestTable, tierLabel } from "./RelayRequestTable";
import { bucketKey, bucketLabel, compactTokens, RelayUsageChart } from "./RelayUsageChart";

type Range = { mode: "week" | "today" | "custom"; from: string; to: string };
const EMPTY_FILTERS = { model: "", provider: "", dimension: "" };

export function RelayMetric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="relay-work-metric"><dt>{label}</dt><dd>{value}{note && <small>{note}</small>}</dd></div>;
}

export function RelayUsageView({ rows, today, initialPeriod, rates, onRequest, onPricing, onPeriodChange }: {
  rows: RelayLogEntry[];
  today: string;
  initialPeriod: Range["mode"];
  rates: RelayRates;
  onRequest: (row: RelayLogEntry) => void;
  onPricing: () => void;
  onPeriodChange: (period: "week" | "today") => void;
}) {
  const earliest = shiftDay(today, -6);
  const [range, setRange] = useState<Range>({ mode: initialPeriod, from: earliest, to: today });
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [bucket, setBucket] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [info, setInfo] = useState(false);
  const { toast } = useToast();
  const from = range.mode === "week" ? earliest : range.mode === "today" ? today : (range.from < earliest ? earliest : range.from);
  const to = range.mode === "custom" && range.to >= from ? range.to : today;
  const periodRows = useMemo(() => rows.filter((row) => {
    const day = dayKey(row.tsMs);
    return isGeneration(row) && day >= from && day <= to;
  }), [rows, from, to]);

  const models = [...new Set(periodRows.map(actualModel).filter(Boolean))].sort();
  const providers = useMemo(() => {
    const labels = new Map<string, string>();
    for (const row of rows) {
      const key = providerKey(row);
      if (isGeneration(row) && key && !labels.has(key)) labels.set(key, providerLabel(row.upstreamProvider, row.upstreamKey));
    }
    return labels;
  }, [rows]);
  const clients = [...new Set(periodRows.map((row) => row.clientModel).filter(Boolean))].sort();
  const tiers = [...new Set(periodRows.map((row) => row.tier).filter(Boolean))].sort();
  const selectedByBucket = bucket && bucket.slice(0, 10) >= from && bucket.slice(0, 10) <= to && bucket.includes("T") === (from === to) ? bucket : null;

  const comparable = periodRows.filter((row) =>
    (!filters.provider || providerKey(row) === filters.provider) &&
    (!filters.dimension || filters.dimension === `tier:${row.tier}` || filters.dimension === `client:${row.clientModel}`));
  const selected = filters.model ? comparable.filter((row) => actualModel(row) === filters.model) : comparable;
  const details = selectedByBucket ? selected.filter((row) => bucketKey(row, from === to) === selectedByBucket) : selected;
  const summary = summarizeUsage(selected, rates);
  const settled = selected.filter((row) => !isPending(row)).length;
  const ranking = new Map<string, number>();
  for (const row of comparable) {
    const total = tokenTotal(row.usage);
    const model = actualModel(row);
    if (total != null && model) ranking.set(model, (ranking.get(model) ?? 0) + total);
  }
  const ranked = Array.from(ranking).sort((a, b) => b[1] - a[1]);
  const canSetPrice = providers.size > 0;
  const filtered = Boolean(selectedByBucket || filters.model || filters.provider || filters.dimension);

  const changePeriod = (mode: "week" | "today") => {
    setRange({ mode, from: earliest, to: today });
    setBucket(null);
    onPeriodChange(mode);
  };
  const exportCurrent = async () => {
    setExporting(true);
    try {
      const path = await saveTextExport({ title: "导出中转 Token 用量", defaultName: `中转用量-${from}_${to}.csv`, ext: "csv", filterName: "CSV 表格", content: relayUsageCsv(details, rates) });
      if (path) exportedToast(toast, "已导出 Token 用量", path);
    } catch (error) {
      toast(`导出失败：${String(error)}`, "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="relay-work-stack">
      <div className="relay-inline relay-spread relay-usage-toolbar">
        <div className="relay-inline relay-wrap">
          <div className="relay-seg" role="group" aria-label="用量时间范围">
            <button aria-pressed={range.mode === "week"} onClick={() => changePeriod("week")}>近 7 天</button>
            <button aria-pressed={range.mode === "today"} onClick={() => changePeriod("today")}>今天</button>
            <button aria-pressed={range.mode === "custom"} onClick={() => setCustom({ from, to })}>自定义</button>
          </div>
          <select className="relay-work-select" aria-label="实际模型" value={filters.model} onChange={(e) => setFilters({ ...filters, model: e.target.value })}>
            <option value="">全部实际模型</option>{filters.model && !models.includes(filters.model) && <option value={filters.model}>{filters.model}</option>}
            {models.map((model) => <option key={model}>{model}</option>)}
          </select>
          <select className="relay-work-select" aria-label="上游供应商" value={filters.provider} onChange={(e) => setFilters({ ...filters, provider: e.target.value })}>
            <option value="">全部供应商</option>{filters.provider && !providers.has(filters.provider) && <option value={filters.provider}>已筛选上游</option>}
            {Array.from(providers, ([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <select className="relay-work-select" aria-label="客户端模型或档位" value={filters.dimension} onChange={(e) => setFilters({ ...filters, dimension: e.target.value })}>
            <option value="">客户端 / 档位</option>
            {filters.dimension && !tiers.some((tier) => `tier:${tier}` === filters.dimension) && !clients.some((client) => `client:${client}` === filters.dimension) && <option value={filters.dimension}>{filters.dimension.slice(filters.dimension.indexOf(":") + 1)}</option>}
            {tiers.map((tier) => <option key={`t:${tier}`} value={`tier:${tier}`}>档位 · {tierLabel(tier)}</option>)}
            {clients.map((client) => <option key={`c:${client}`} value={`client:${client}`}>客户端 · {client}</option>)}
          </select>
        </div>
        <div className="relay-inline relay-wrap"><small>{shortRelayDay(from)}{from !== to && ` – ${shortRelayDay(to)}`} · 本地时间</small>
          <Button variant="outline" size="sm" disabled={!details.length} isLoading={exporting} onClick={() => void exportCurrent()}><Icon name="download" size={14} />导出 CSV</Button>
        </div>
      </div>

      <section className="relay-work-panel" aria-label="Token 用量概览">
        <dl className="relay-work-metrics relay-usage-metrics">
          <RelayMetric label="总 Token" value={compactTokens(summary.total)} />
          <RelayMetric label="输入 Token" value={compactTokens(summary.input)} />
          <RelayMetric label="输出 Token" value={compactTokens(summary.counts.output)} />
          <RelayMetric label="缓存命中率" value={summary.hit == null ? "—" : `${summary.hit.toFixed(1)}%`} />
          <RelayMetric label="预估费用" value={moneyLabel(summary.cost)} note={summary.priced > 0 && summary.priced < settled ? "部分" : undefined} />
        </dl>
        <div className="relay-usage-analysis">
          <RelayUsageChart rows={selected} from={from} to={to} selected={selectedByBucket} onSelect={(id) => setBucket(id === selectedByBucket ? null : id)} />
          <section className="relay-usage-analysis-panel" aria-label="Token 构成">
            <div className="relay-inline relay-spread"><h3>Token 构成</h3><Button size="sm" variant="ghost" aria-label="查看统计口径" onClick={() => setInfo(true)}><Icon name="info" size={15} /></Button></div>
            <dl className="relay-token-breakdown">{TOKEN_FIELDS.map(({ key, label }) => <div key={key}><dt><i data-count={key} />{label}</dt><dd>{summary.counts[key] == null ? "—" : formatInt(summary.counts[key])}</dd></div>)}</dl>
            <div className="relay-coverage relay-inline relay-wrap relay-spread">
              <small>{settled ? `上报用量 ${formatInt(summary.covered)} / ${formatInt(settled)} 条${summary.partial ? ` · ${summary.partial} 条部分采集` : ""}` : "暂无已结束请求"}{summary.priced > 0 && ` · ${summary.priced} 条已估价`}</small>
              {canSetPrice && <button className="relay-text-button" type="button" onClick={onPricing}>配置单价</button>}
            </div>
          </section>
        </div>
        <div className="relay-model-ranking relay-inline relay-wrap">
          <small>实际模型排行</small>
          {ranked.length ? ranked.slice(0, 5).map(([model, count]) => <button key={model} type="button" className="relay-rank-item" aria-pressed={filters.model === model} onClick={() => setFilters({ ...filters, model: filters.model === model ? "" : model })}>{model} <b>{compactTokens(count)}</b></button>) : <small>暂无上报用量</small>}
        </div>
      </section>

      <section className="relay-work-panel" aria-labelledby="relay-usage-requests">
        <header className="relay-section-head"><div><h2 id="relay-usage-requests">逐请求用量</h2><p>选择一条记录，查看缓存和费用构成。</p></div>
          {filtered && <div className="relay-inline relay-wrap">{selectedByBucket && <button className="relay-rank-item" type="button" onClick={() => setBucket(null)}>{bucketLabel(selectedByBucket)} <Icon name="close" size={12} /></button>}
            <Button variant="ghost" size="sm" onClick={() => { setBucket(null); setFilters(EMPTY_FILTERS); }}>清除筛选</Button>
          </div>}
        </header>
        <RelayRequestTable key={JSON.stringify([from, to, filters, selectedByBucket])} rows={details} usage rates={rates} onRequest={onRequest}
          empty={filtered ? "没有符合筛选条件的请求。" : "这段时间内没有模型生成请求。"} />
        <p className="relay-work-footnote">保留近 7 天明细，包含今天。Token 预估请求单独出现在请求路由中。</p>
      </section>
      {custom && <Modal open ariaLabel="自定义时间" onClose={() => setCustom(null)} className="relay-small-dialog modal-surface">
        <h2>自定义时间</h2><p>可查看 {shortRelayDay(earliest)}–{shortRelayDay(today)} 的记录。</p>
        <div className="relay-date-fields">
          <label>开始日期<input className="relay-work-select" type="date" min={earliest} max={custom.to} value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
          <label>结束日期<input className="relay-work-select" type="date" min={custom.from} max={today} value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
        </div>
        <div className="relay-inline relay-end"><Button size="sm" variant="ghost" onClick={() => setCustom(null)}>取消</Button><Button size="sm" disabled={!custom.from || !custom.to || custom.from < earliest || custom.to > today || custom.from > custom.to}
          onClick={() => { setRange({ mode: "custom", ...custom }); setBucket(null); setCustom(null); }}>应用日期</Button></div>
      </Modal>}
      {info && <Modal open ariaLabel="Token 统计口径" onClose={() => setInfo(false)} className="relay-small-dialog modal-surface">
        <h2>Token 统计口径</h2><p>输入包含未缓存输入、缓存写入和缓存读取。总 Token 为输入与输出的合计。</p>
        <p>缓存命中率为缓存读取 Token 占全部输入 Token 的比例。部分采集仅汇总上游已返回的字段。</p>
        <p>预估费用以当前配置的美元单价计算，覆盖用量完整且有对应单价的记录。</p>
        <Button size="sm" onClick={() => setInfo(false)}>知道了</Button>
      </Modal>}
    </div>
  );
}
