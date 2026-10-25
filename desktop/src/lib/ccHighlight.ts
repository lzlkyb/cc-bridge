/**
 * 历史会话搜索的命中高亮。
 *
 * 切片规则与 Rust 侧 `cc_history::index::search` 的 SQL 逐参数一一对应：
 * `<3` 字符整串、`≥3` 字符 3 字滑窗（重叠）。**两边用同一批例子锁死**
 * （各自测试里的「修复登录」四字查询），改一边必须同步改另一边，
 * 否则会出现「SQL 说命中、界面找不到高亮位置」的分裂。
 *
 * 为什么高亮要标片段而不是整串：滑窗命中的片段可能分散在标题和摘要里、
 * 相隔很远，整串标注会把没命中的字也涂上。
 */

/** 一个高亮片段。`hit: false` 的是命中之间的原文。 */
export type HighlightSegment = { text: string; hit: boolean };

/**
 * 查询切片：`<3` 字符原样一片，`≥3` 字符按 3 字**滑窗**（互相重叠）拆。
 *
 * 按字符不按字节：中文一个字 3 字节，按字节切会把字劈开。
 * 空查询返回空数组（调用方按「无高亮」处理）。
 */
export function searchChunks(query: string): string[] {
  const chars = Array.from(query.trim());
  if (chars.length === 0) return [];
  if (chars.length < 3) return [chars.join("")];
  const out: string[] = [];
  for (let i = 0; i + 3 <= chars.length; i++) out.push(chars.slice(i, i + 3).join(""));
  return out;
}

/**
 * 把文本切成「命中 / 未命中」交替的片段，供渲染 `<mark>` 用。
 *
 * 所有 chunk 的全部出现位置先收集、再合并重叠或相邻的区间 —— 相邻 chunk
 * 的首尾必然重叠（「修复登录」的 修复登 与 正登录 差一个字），不合并的话
 * 一个连续命中会被切成三段，界面像碎碎念。
 *
 * 大小写不敏感与 SQLite 的 ASCII LIKE 对齐：英文查询 `login` 能高亮 `Login`。
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const chunks = searchChunks(query);
  if (chunks.length === 0 || text === "") return [{ text, hit: false }];

  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const chunk of chunks) {
    const needle = chunk.toLowerCase();
    // from = at + 1：重叠出现也要找（同一 chunk 在文本里可能出现多次）。
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
      ranges.push([at, at + needle.length]);
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    // `<=` 把首尾相接的区间也并起来：相邻命中看上去是一整片。
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const segs: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segs.push({ text: text.slice(cursor, start), hit: false });
    segs.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segs.push({ text: text.slice(cursor), hit: false });
  return segs;
}
