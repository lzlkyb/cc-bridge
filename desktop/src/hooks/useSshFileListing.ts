import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import { cleanErr } from "../lib/utils";
import type { SshFileEntry } from "../lib/types";

interface Listing {
  connectionId: string; path: string; entries: SshFileEntry[];
  loading: boolean; error: string | null;
}

/**
 * 目录快照缓存：面板一关就 unmount，重开时先用上次的列表顶上，再后台刷新。
 *
 * WHY：本机 OpenSSH 没有连接复用（Windows 版无 ControlMaster），每次列目录都是一次
 * 真实往返，冷启动时还要先建登录会话。空表 + 转圈会让人以为「点死了」，而上一份快照
 * 在绝大多数情况下仍然接近真相——目录内容变得慢。
 *
 * 只缓存 entries，**不缓存 loading / error**：错误必须如实反映这一次请求的结果，
 * 否则「目录已删除」会被旧快照伪装成正常。
 *
 * 上限 24 条：文件面板通常只在几个目录之间来回切，给太多既无收益又占内存。
 */
const SNAPSHOT_LIMIT = 24;
const snapshots = new Map<string, SshFileEntry[]>();
const snapKey = (connectionId: string, path: string) => `${connectionId}\n${path}`;

function writeSnapshot(key: string, entries: SshFileEntry[]) {
  // 先删再插：Map 的插入序即淘汰序，命中一次就把它挪到最新。
  snapshots.delete(key);
  snapshots.set(key, entries);
  while (snapshots.size > SNAPSHOT_LIMIT) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

/** A directory and its rows are one snapshot; late responses never cross navigation boundaries. */
export function useSshFileListing(connectionId: string, path: string) {
  const [snapshot, setSnapshot] = useState<Listing>(() => ({
    connectionId,
    path,
    // 首次挂载（= 每次重开面板，父组件按连接/路径给了 key）直接拿快照，省掉一帧空白。
    entries: snapshots.get(snapKey(connectionId, path)) ?? [],
    loading: true,
    error: null,
  }));
  const request = useRef({ id: 0 });
  const active = useRef(true);
  const latest = useRef({ connectionId, path });
  latest.current = { connectionId, path };
  const refresh = useCallback(async () => {
    // An upload may finish after navigation. Its old refresh callback must not claim the new view.
    if (!active.current || latest.current.connectionId !== connectionId || latest.current.path !== path) return;
    const id = ++request.current.id;
    const current = () => request.current.id === id && latest.current.connectionId === connectionId && latest.current.path === path;
    const key = snapKey(connectionId, path);
    setSnapshot(old => ({
      connectionId,
      path,
      // 同一目录的刷新沿用当前结果（别自己闪一下）；换目录则用快照打底，先有东西可看可点。
      entries: old.connectionId === connectionId && old.path === path ? old.entries : snapshots.get(key) ?? [],
      loading: true,
      error: null,
    }));
    try {
      const entries = await invoke<SshFileEntry[]>("ssh_sftp_list", { connectionId, path });
      if (!current()) return;
      const sorted = [...entries].sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
      writeSnapshot(key, sorted);
      setSnapshot({ connectionId, path, entries: sorted, loading: false, error: null });
    } catch (error) {
      if (current()) setSnapshot({ connectionId, path, entries: [], loading: false, error: `列目录失败：${cleanErr(error)}` });
    }
  }, [connectionId, path]);
  useEffect(() => {
    active.current = true;
    const requests = request.current;
    void refresh();
    return () => { active.current = false; requests.id++; };
  }, [refresh]);
  const matches = snapshot.connectionId === connectionId && snapshot.path === path;
  // Mask the old snapshot during render, before the navigation effect starts its request.
  return { entries: matches ? snapshot.entries : [], loading: !matches || snapshot.loading, error: matches ? snapshot.error : null, refresh };
}
