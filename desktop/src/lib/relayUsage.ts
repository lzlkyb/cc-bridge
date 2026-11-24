import type { RelayLogEntry } from "./types";

export const TOKEN_FIELDS = [
  { key: "input", label: "未缓存输入" },
  { key: "cacheWrite", label: "缓存写入" },
  { key: "cacheRead", label: "缓存读取" },
  { key: "output", label: "输出" },
] as const;

export type TokenField = typeof TOKEN_FIELDS[number]["key"];
export type TokenCounts = Record<TokenField, number | null>;
export type RelayRates = Record<string, TokenCounts>;

export const NO_TOKENS: TokenCounts = { input: null, cacheWrite: null, cacheRead: null, output: null };
const RATE_STORAGE_KEY = "ccbridge.relay.usd-per-million";
const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function relayKey(row: RelayLogEntry) {
  return row.requestId ?? `${row.tsMs}:${row.id}`;
}

export function mergeRelayHistory(history: RelayLogEntry[], recent: RelayLogEntry[]) {
  const map = new Map(history.map((row) => [relayKey(row), row]));
  for (const row of recent) {
    const prior = map.get(relayKey(row));
    if (!prior || !isPending(row) || (isPending(prior) || prior.status == null)) map.set(relayKey(row), row);
  }
  return [...map.values()].sort((a, b) => b.tsMs - a.tsMs || b.id - a.id);
}

export function dayKey(at: number | Date) {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function shiftDay(day: string, by: number) {
  const [year, month, date] = day.split("-").map(Number);
  return dayKey(new Date(year, month - 1, date + by));
}

export function shortRelayDay(day: string) {
  return `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`;
}

export function isGeneration(row: RelayLogEntry) {
  return row.path === "/v1/messages";
}

export function isPending(row: RelayLogEntry) {
  return row.status == null && !row.error;
}

export function isRelayError(row: RelayLogEntry) {
  return Boolean(row.error || (row.status != null && row.status >= 400));
}

export function relayOutcome(row: RelayLogEntry) {
  if (row.error === "客户端提前断开") return { label: "客户端断开", tone: "mute" };
  if (row.status === 429) return { label: "上游限流", tone: "warn" };
  if (row.status === 401 || row.status === 403) return { label: "认证失败", tone: "bad" };
  if (isRelayError(row)) return { label: "失败", tone: "bad" };
  if (isPending(row)) return { label: "处理中", tone: "mute" };
  return row.status === 200 || (row.status != null && row.status < 300)
    ? { label: "成功", tone: "ok" } : { label: `HTTP ${row.status}`, tone: "warn" };
}

export function relayUsageState(row: RelayLogEntry) {
  if (!isGeneration(row)) return "Token 预估请求";
  if (isPending(row)) return "等待上报";
  if (!row.usage && row.usageCollectionIssue === "responseTooLarge") return "响应过大，未采集";
  if (!row.usage && row.usageCollectionIssue === "unsupportedEncoding") return "响应编码不支持采集";
  return row.usage ? row.usage.partial ? "部分采集" : "上游已上报" : "上游未上报";
}

export function actualModel(row: RelayLogEntry) {
  return row.reportedModel || row.upstreamModel;
}

export function providerLabel(provider?: string | null, endpointKey?: string | null) {
  const label = provider?.replace(/^https?:\/\//, "") || "未知上游";
  return endpointKey ? `${label} · ${endpointKey.slice(0, 6)}` : label;
}

export function providerKey(row: RelayLogEntry) {
  return row.upstreamKey || row.upstreamProvider || "";
}

export function rateKey(row: RelayLogEntry) {
  const provider = providerKey(row);
  return provider && actualModel(row) ? JSON.stringify([provider, actualModel(row)]) : null;
}

export function tokenTotal(counts: TokenCounts | null | undefined, onlyInput = false) {
  const values = TOKEN_FIELDS.filter(({ key }) => !onlyInput || key !== "output").map(({ key }) => counts?.[key] ?? null);
  return values.every((value) => value == null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function estimateCost(row: RelayLogEntry, rates: RelayRates) {
  const key = rateKey(row);
  const rate = key ? rates[key] : undefined;
  const usage = row.usage;
  if (!rate || !usage || usage.partial) return null;
  let cost = 0;
  for (const { key } of TOKEN_FIELDS) {
    const tokens = usage[key] ?? 0;
    const price = rate[key];
    if (tokens && price == null) return null;
    cost += tokens * (price ?? 0) / 1_000_000;
  }
  return Number.isFinite(cost) ? cost : null;
}

export function moneyLabel(amount: number | null) {
  return amount == null ? "—" : MONEY.format(amount);
}

export function summarizeUsage(rows: RelayLogEntry[], rates?: RelayRates) {
  const counts = { ...NO_TOKENS };
  let covered = 0;
  let partial = 0;
  let priced = 0;
  let cost = 0;
  for (const row of rows) {
    if (!row.usage) continue;
    covered++;
    if (row.usage.partial) partial++;
    for (const { key } of TOKEN_FIELDS) {
      const value = row.usage[key];
      if (value != null) counts[key] = (counts[key] ?? 0) + value;
    }
    const amount = rates ? estimateCost(row, rates) : null;
    if (amount != null) {
      priced++;
      cost += amount;
    }
  }
  const input = tokenTotal(counts, true);
  return {
    counts, covered, partial, priced, input, total: tokenTotal(counts), cost: priced ? cost : null,
    hit: input && counts.cacheRead != null ? 100 * counts.cacheRead / input : null,
  };
}

export function loadRelayRates(): RelayRates {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RATE_STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, rate]) => rate && TOKEN_FIELDS.every(({ key }) => rate[key] === null || (typeof rate[key] === "number" && Number.isFinite(rate[key]) && rate[key] >= 0))));
  } catch {
    return {};
  }
}

export function saveRelayRates(rates: RelayRates) {
  localStorage.setItem(RATE_STORAGE_KEY, JSON.stringify(rates));
}

export function relayUsageCsv(rows: RelayLogEntry[], rates: RelayRates) {
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    // Model names and identifiers can come from upstream. Keep CSV cells inert in spreadsheets.
    const safe = typeof value === "string" && /^(?:\s*[=+\-@]|[\t\r\n])/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const fields = ["请求 ID", "本地时间", "客户端模型", "实际模型", "上游供应商", "请求档位", "结果", ...TOKEN_FIELDS.map(({ label }) => label), "总 Token", "预估费用 USD", "用量状态"];
  const lines = rows.map((row) => [
    relayKey(row), `${dayKey(row.tsMs)} ${new Date(row.tsMs).toLocaleTimeString("zh-CN", { hour12: false })}`, row.clientModel,
    actualModel(row), providerLabel(row.upstreamProvider, row.upstreamKey), row.tier, relayOutcome(row).label,
    ...TOKEN_FIELDS.map(({ key }) => row.usage?.[key]), tokenTotal(row.usage), estimateCost(row, rates), relayUsageState(row),
  ]);
  return `\ufeff${[fields, ...lines].map((line) => line.map(cell).join(",")).join("\r\n")}`;
}
