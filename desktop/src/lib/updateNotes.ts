import { CHANGELOG, type ChangelogEntry } from "./about";

export interface UpdateNotesInfo {
  version?: string;
  currentVersion?: string;
  date?: string | null;
  body?: string | null;
}

export interface ReleaseContent {
  summary: string[];
  highlights: string[];
  groups: { label: string; items: string[] }[];
  paragraphs: string[];
}

export interface UpdateRelease extends ReleaseContent {
  version: string;
  date?: string | null;
}

const HISTORY = /<!-- cc-bridge-release-history:([\s\S]*?) -->/;
const LABELS: Record<string, string> = { 新增: "新增", 变更: "改进", 优化: "改进", 技术: "改进", 依赖: "改进", 测试: "改进", 说明: "改进", 修复: "修复", 安全: "安全" };
const PRIVATE = new Set(["用户摘要", "技术细节", "实现说明", "开发者"]);

/** Only stable semantic versions participate in ranges; unknown versions get latest-only notes. */
export function compareReleaseVersions(a: string, b: string): number | null {
  const parse = (version: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const left = parse(a), right = parse(b);
  if (!left || !right) return null;
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function parseUpdateNotes(body?: string | null): ReleaseContent {
  const result: ReleaseContent = { summary: [], highlights: [], groups: [], paragraphs: [] };
  let section = "", last: string[] | undefined;
  for (const raw of (body ?? "").replace(HISTORY, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { last = undefined; continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { section = heading[1].trim(); last = undefined; continue; }
    if (PRIVATE.has(section)) continue;
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (section === "更新摘要") last = result.summary;
    else if (section === "亮点" || section === "Highlights") last = result.highlights;
    else if (item) {
      const label = LABELS[section] ?? (section || "更新内容");
      let group = result.groups.find((entry) => entry.label === label);
      if (!group) { group = { label, items: [] }; result.groups.push(group); }
      last = group.items;
    } else if (last?.length) {
      last[last.length - 1] += " " + line;
      continue;
    } else last = result.paragraphs;
    last.push(item?.[1] ?? line);
  }
  return result;
}

function bundledRelease(entry: ChangelogEntry): UpdateRelease {
  const labels = { feat: "新增", improve: "改进", fix: "修复", sec: "安全" };
  const groups: ReleaseContent["groups"] = [];
  for (const item of entry.items) {
    const label = labels[item.category];
    let group = groups.find((existing) => existing.label === label);
    if (!group) { group = { label, items: [] }; groups.push(group); }
    group.items.push(item.text);
  }
  return { version: entry.version, date: entry.date, groups, summary: [], paragraphs: [], highlights: entry.highlights ?? [] };
}

function readHistory(body?: string | null): UpdateRelease[] {
  const metadata = HISTORY.exec(body ?? "")?.[1];
  if (!metadata) return [];
  try {
    const entries: unknown = JSON.parse(metadata);
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry): entry is { version: string; date?: string; body: string } =>
      !!entry && typeof entry.version === "string" && typeof entry.body === "string" &&
      (entry.date === undefined || typeof entry.date === "string"),
    ).map((entry) => ({ version: entry.version, date: entry.date, ...parseUpdateNotes(entry.body) }));
  } catch { return []; }
}

const hasContent = (entry: ReleaseContent) => entry.groups.length || entry.summary.length || entry.paragraphs.length || entry.highlights.length;
export const countReleaseItems = (entry: ReleaseContent) => entry.groups.reduce((sum, group) => sum + group.items.length, 0);

export function createUpdateNotesModel(update: UpdateNotesInfo, bundled: ChangelogEntry[] = CHANGELOG) {
  const version = (update.version ?? "").replace(/^v/, "");
  const remote = readHistory(update.body);
  const history = remote.length ? remote : bundled.map(bundledRelease);
  const matching = history.find((entry) => compareReleaseVersions(entry.version, version) === 0);
  const body = parseUpdateNotes(update.body);
  const latest: UpdateRelease = {
    ...(matching ?? body), version, date: update.date ?? matching?.date,
    // Explicit server notes remain authoritative; metadata fills out the full history only.
    ...(hasContent(body) ? body : {}),
    highlights: body.highlights.length ? body.highlights : matching?.highlights ?? [],
  };
  const current = update.currentVersion;
  const canAggregate = current && compareReleaseVersions(version, current) !== null && compareReleaseVersions(version, current)! > 0;
  const previous = canAggregate ? history.filter((entry) =>
    (compareReleaseVersions(entry.version, current) ?? -1) > 0 &&
    (compareReleaseVersions(entry.version, version) ?? 1) < 0,
  ) : [];
  const releases = [latest, ...previous].sort((a, b) => compareReleaseVersions(b.version, a.version) ?? 0);
  const counts: Record<string, number> = {};
  for (const release of releases) for (const group of release.groups) counts[group.label] = (counts[group.label] ?? 0) + group.items.length;
  const seen = new Set<string>();
  // One per release first, so a verbose newest release cannot hide skipped-version benefits.
  const candidates = releases.flatMap((release) => release.highlights.slice(0, 1).map((text) => ({ version: release.version, text })));
  candidates.push(...releases.flatMap((release) => release.highlights.slice(1).map((text) => ({ version: release.version, text }))));
  const highlights = candidates.filter(({ text }) => {
    const key = text.replace(/\*\*/g, "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 4);
  return { latest, releases, counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), highlights };
}
