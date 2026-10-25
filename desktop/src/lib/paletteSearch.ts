import { pinyin } from "pinyin-pro";

/**
 * 命令面板的检索内核（设计稿《命令面板-拼音模糊与最近使用》）。
 *
 * 三路命中，分数从高到低：label 子串 > label 子序列 > keywords 子串 >
 * 拼音全拼连续 > 拼音首字母子序列。同分保持声明顺序（导航在前）。
 *
 * 拼音只服务「匹配 + 注音提示」，不改 label 本身；只在查询是纯 ascii
 * 字母时参与（中文查询走 label 子串路就够了）。
 *
 * 全部纯函数（frecency 除外，它要 localStorage），单测见 `paletteSearch.test.ts`。
 */

export type PaletteItemLike = { id: string; label: string; keywords?: string };

export type PinyinHit = { syllables: string[]; /** 命中的音节下标（注音槽加亮用）。 */ hitIdx: number[] };

export type PaletteMatch<T> = {
  item: T;
  score: number;
  /** label 中命中的字符下标（子串/子序列高亮用；拼音命中时为空）。 */
  labelHits: number[];
  /** 拼音命中的注音信息。 */
  pinyin?: PinyinHit;
};

export type PreparedItem<T> = { item: T; py: { syllables: string[]; full: string; initials: string } };

/** 预生成拼音索引。条目几十条、每条一次，微秒级 —— items 变化时重建。 */
export function preparePaletteItems<T extends PaletteItemLike>(items: T[]): PreparedItem<T>[] {
  return items.map((item) => {
    const syllables = pinyin(item.label, { toneType: "none", type: "array" }) as string[];
    return { item, py: { syllables, full: syllables.join(""), initials: syllables.map((s) => s[0] ?? "").join("") } };
  });
}

/** 子序列匹配：返回 needle 各字符在 hay 中的下标（贪心、保序），不命中返回 null。 */
export function subsequenceHits(hay: string, needle: string): number[] | null {
  if (!needle) return null;
  const h = hay.toLowerCase();
  const hits: number[] = [];
  let at = 0;
  for (const ch of needle) {
    if (ch.trim() === "") continue;
    const found = h.indexOf(ch, at);
    if (found < 0) return null;
    hits.push(found);
    at = found + 1;
  }
  return hits.length > 0 ? hits : null;
}

/** 全拼命中 → 命中的音节下标（`full` 里 [at, at+len) 覆盖到的音节）。 */
function fullHitSyllables(syllables: string[], at: number, len: number): number[] {
  const hits: number[] = [];
  let off = 0;
  for (let i = 0; i < syllables.length; i++) {
    const s = syllables[i];
    if (off + s.length > at && off < at + len && /[a-z]/.test(s)) hits.push(i);
    off += s.length;
  }
  return hits;
}

/** 首字母子序列 → 命中的音节下标（initials[i] 与 syllables[i] 一一对应）。 */
function initialsHitSyllables(hits: number[], syllables: string[]): number[] {
  return hits.filter((i) => i < syllables.length && /[a-z]/.test(syllables[i]));
}

export function searchPalette<T extends PaletteItemLike>(prepared: PreparedItem<T>[], query: string): PaletteMatch<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return prepared.map(({ item }) => ({ item, score: 0, labelHits: [] }));

  const out: Array<PaletteMatch<T> & { idx: number }> = [];
  prepared.forEach((entry, idx) => {
    const { item, py } = entry;
    const at = item.label.toLowerCase().indexOf(q);
    if (at >= 0) {
      const labelHits: number[] = [];
      for (let i = 0; i < q.length; i++) labelHits.push(at + i);
      out.push({ item, idx, score: 100 - Math.min(at, 50) * 0.2, labelHits });
      return;
    }
    const sub = subsequenceHits(item.label, q);
    if (sub) {
      out.push({ item, idx, score: 70, labelHits: sub });
      return;
    }
    if (item.keywords?.toLowerCase().includes(q)) {
      out.push({ item, idx, score: 60, labelHits: [] });
      return;
    }
    if (/^[a-z]+$/.test(q)) {
      const fullAt = py.full.indexOf(q);
      if (fullAt >= 0) {
        out.push({ item, idx, score: 50, labelHits: [], pinyin: { syllables: py.syllables, hitIdx: fullHitSyllables(py.syllables, fullAt, q.length) } });
        return;
      }
      const initHits = subsequenceHits(py.initials, q);
      if (initHits) {
        out.push({ item, idx, score: 30, labelHits: [], pinyin: { syllables: py.syllables, hitIdx: initialsHitSyllables(initHits, py.syllables) } });
      }
    }
  });

  // 稳定排序：分数降序，同分保持声明顺序（idx 升序）。
  out.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return out;
}

/* ── frecency：最近使用置顶（只在本机 localStorage，不上传不进配置）──── */

const FRECENCY_KEY = "ccbridge_palette_frecency";

type FrecencyRecord = Record<string, { n: number; t: number }>;

function readFrecency(): FrecencyRecord {
  try {
    const raw = localStorage.getItem(FRECENCY_KEY);
    return raw ? (JSON.parse(raw) as FrecencyRecord) : {};
  } catch {
    return {};
  }
}

/** 记一次使用。顺手裁掉最老的记录（只留 50 条，别让这玩意长成无界表）。 */
export function recordPaletteUse(id: string): void {
  try {
    const rec = readFrecency();
    rec[id] = { n: (rec[id]?.n ?? 0) + 1, t: Date.now() };
    const entries = Object.entries(rec);
    if (entries.length > 50) {
      entries.sort((a, b) => b[1].t - a[1].t);
      for (const [k] of entries.slice(50)) delete rec[k];
    }
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(rec));
  } catch {
    // 存储不可用：最近使用降级为不显示，不影响检索
  }
}

/** frecency 分数：次数 × 距今衰减。两小时前用过的权重约是刚用的一半。 */
export function frecencyScore(entry: { n: number; t: number }, now = Date.now()): number {
  const hours = (now - entry.t) / 3_600_000;
  return entry.n / (hours + 2);
}

/** 空查询时置顶的「最近使用」条目 id（按分数取前 limit 条，只在传入 items 里挑）。 */
export function recentPaletteIds<T extends PaletteItemLike>(items: T[], limit = 5): string[] {
  let rec: FrecencyRecord;
  try {
    rec = readFrecency();
  } catch {
    return [];
  }
  const live = new Set(items.map((i) => i.id));
  return Object.entries(rec)
    .filter(([id]) => live.has(id))
    .map(([id, e]) => ({ id, s: frecencyScore(e) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.id);
}
