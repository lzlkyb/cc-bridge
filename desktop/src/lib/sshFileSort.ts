import type { SshFileEntry } from "./types";

/** 可排序的列：与表头「名称 / 大小 / 修改时间」三列一一对应。 */
export type SortKey = "name" | "size" | "mtime";
export type SortDir = "asc" | "desc";

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** 默认排序：名称升序 + 目录优先（与列目录现状一致，不引入「目录文件混排」的新心智）。 */
export const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };

/**
 * 目录优先 + 按列排序 + 同值按名称次级排序。**纯函数**（R11：公共纯函数归 lib）。
 *
 * 「目录恒优先」是**分组规则**而不是比较器的第一项：目录整块压在最上方，
 * 且组内**恒按名称升序**，不跟随主列与方向翻面。WHY：
 * - 设计稿（design/文件面板重命名与排序-设计稿-2026-11-24.html）排序场景的
 *   注释写的是「目录仍在顶部，**文件**按大小降序」——主列只作用于文件；
 * - 目录的大小列在 UI 里显示「—」（SshFileRow），按一个用户看不见的数排
 *   目录，顺序会显得莫名其妙；文件的大小才是用户点的那个「大小」。
 *
 * 文件之间：主列排序，同值 tie-break 恒为名称升序（不随主方向翻面）：
 * 同样输入永远得到同样输出，可复现，测试也能钉死顺序。
 */
export function sortEntries(entries: SshFileEntry[], sort: SortState): SshFileEntry[] {
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    // 目录块组内恒名称升序（见上方 WHY）：切列、翻方向都不动它。
    if (a.isDir && b.isDir) return a.name.localeCompare(b.name);
    let primary = 0;
    if (sort.key === "name") primary = a.name.localeCompare(b.name);
    else if (sort.key === "size") primary = a.size - b.size;
    else primary = a.mtime - b.mtime;
    if (primary !== 0) return primary * factor;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 表头点击的排序轮换（设计稿「表头点击即排序」）：
 * - 换列 → 新列**降序**（大的在前，首次点击最常想看的）；
 * - 同列降序 → 升序；
 * - 同列升序 → 回默认（名称升序 + 目录优先）。
 *
 * 🔴 名称列是默认列，「升序」与「默认」是同一个值，纯函数分不开「用户已经
 * 轮到升序」和「本来就停在默认」。若按上面第三条把默认态的再点击判成空操作，
 * 「首次点击降序」对名称列永远不成立（默认即名称升序）——点一下没反应比
 * 轮换不完美更糟。所以名称列在升序态再点翻面到降序：它的「回到默认」
 * 就是第二次点击（升序 ≡ 默认），轮换在 desc/asc 之间翻转。
 */
export function nextSortState(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, dir: "desc" };
  if (current.dir === "desc") return { key, dir: "asc" };
  if (current.key === DEFAULT_SORT.key) return { key, dir: "desc" };
  return DEFAULT_SORT;
}

/**
 * 名称子串过滤。纯函数。
 *
 * 大小写不敏感；**纯文本匹配不是正则**——用户输入的任何字符（`.`、`*`、`[`）
 * 都按字面找，不会因为正则语法把结果搅乱。空/纯空白 = 不过滤。
 * 目录与文件一起过滤：目录名命中也该显示。
 */
export function filterEntries(entries: SshFileEntry[], query: string): SshFileEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}
