import { useCallback, useMemo, useState } from "react";
import type { SshFileEntry } from "../lib/types";
import {
  DEFAULT_SORT,
  filterEntries,
  nextSortState,
  sortEntries,
  type SortKey,
  type SortState,
} from "../lib/sshFileSort";

/**
 * 列表的「看法」：排序 + 过滤，从列目录的**原始结果**派生。
 *
 * WHY 派生而不是把排序结果写进快照：目录快照（`useSshFileListing`）存的必须是
 * 服务器说的原始顺序——排序是用户当下怎么看的选择，混进缓存会让「快照」不再是
 * 服务器事实；且用户上次按大小排过，重开面板时旧排序会阴魂不散地盖在新内容上。
 *
 * 换目录清空过滤词（路径变了还留着上个目录的词，会列出一小堆，让人以为文件
 * 丢了）；**排序偏好保留**（按大小排着进子目录仍按大小，是预期行为）。
 */
export function useSshFileView(entries: SshFileEntry[], path: string) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [query, setQuery] = useState("");
  // 渲染期调整状态（React 官方「prop 变化时重置 state」模式）：不用 effect，
  // 否则新目录的头几帧会挂着上个目录的过滤词，闪一帧残缺列表。
  const [prevPath, setPrevPath] = useState(path);
  if (prevPath !== path) {
    setPrevPath(path);
    setQuery("");
  }
  const items = useMemo(
    () => filterEntries(sortEntries(entries, sort), query),
    [entries, sort, query],
  );
  const toggleSort = useCallback((key: SortKey) => setSort((cur) => nextSortState(cur, key)), []);
  return { items, sort, toggleSort, query, setQuery };
}
