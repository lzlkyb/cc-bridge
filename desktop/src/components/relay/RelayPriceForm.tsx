import { useState } from "react";
import { Button } from "../ui/button";
import { NO_TOKENS, actualModel, isGeneration, requestProviderLabel, rateKey, TOKEN_FIELDS, type RelayRates, type TokenCounts } from "../../lib/relayUsage";
import type { RelayLogEntry } from "../../lib/types";

export function RelayPriceForm({ rows, initial, rates, onSave }: { rows: RelayLogEntry[]; initial?: RelayLogEntry; rates: RelayRates; onSave: (rates: RelayRates) => void }) {
  const choices = new Map<string, RelayLogEntry>();
  for (const row of initial ? [initial, ...rows] : rows) {
    const key = rateKey(row);
    if (isGeneration(row) && key && !choices.has(key)) choices.set(key, row);
  }
  const [selected, setSelected] = useState((initial && rateKey(initial)) || choices.keys().next().value || "");
  if (!selected) return <p>收到带有上游模型信息的请求后，就可以为该模型配置单价。</p>;
  return <><label className="relay-price-field">上游配置与实际模型
    <select className="relay-work-select" value={selected} onChange={(e) => setSelected(e.target.value)}>
      {Array.from(choices, ([key, row]) => <option key={key} value={key}>{requestProviderLabel(row)} · {actualModel(row)}</option>)}
    </select>
  </label><RateFields key={selected} current={rates[selected]} onSave={(values) => onSave({ ...rates, [selected]: values })} /></>;
}

function RateFields({ current, onSave }: { current?: TokenCounts; onSave: (values: TokenCounts) => void }) {
  const [fields, setFields] = useState(() => Object.fromEntries(TOKEN_FIELDS.map(({ key }) => [key, current?.[key]?.toString() ?? ""])));
  const values = { ...NO_TOKENS };
  let invalid = false;
  for (const { key } of TOKEN_FIELDS) {
    if (!fields[key]) continue;
    const value = Number(fields[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) invalid = true;
    else values[key] = value;
  }

  return <><p className="relay-work-muted">输入美元单价（每百万 Token）。免费项填 0，未知项留空。历史明细会用当前单价估算。</p>
    <div className="relay-price-grid">{TOKEN_FIELDS.map(({ key, label }) => <label key={key} className="relay-price-field">{label}
      <input className="relay-work-select" type="number" min="0" max="1000000" step="any" value={fields[key]} onChange={(e) => setFields({ ...fields, [key]: e.target.value })} />
    </label>)}</div>
    {invalid && <p role="alert">请输入 0 到 1,000,000 之间的有效单价。</p>}
    <div className="relay-inline relay-end"><Button size="sm" disabled={invalid} onClick={() => onSave(values)}>保存单价</Button></div>
  </>;
}
