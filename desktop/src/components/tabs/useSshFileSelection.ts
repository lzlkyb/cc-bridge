import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SshFileEntry } from "../../lib/types";

interface Params {
  entries: SshFileEntry[];
  /** 下载一个条目。 */
  onDownload: (name: string) => void | Promise<void>;
  /** 传输 / 列目录进行中：禁用批量操作（并发 ssh 握手会把成本乘以 N）。 */
  busy: boolean;
}

/**
 * 文件列表的多选 + 批量下载 / 批量删除。
 *
 * 多选文件按顺序进入下载流程（分别选择保存位置），删除可一次确认批量执行。
 *
 * 交互对齐资源管理器：单击选中、Ctrl/⌘+点击多选、Shift+点击选一段、双击目录进入、
 * 双击文件下载（`SshFileRow` 里实现）。
 * 目录不参与批量删除：删除目录是递归删，风险与单文件不同，仍走行尾按钮。
 */
export function useSshFileSelection({ entries, onDownload, busy }: Params) {
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const downloading = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const names = useMemo(() => entries.map((e) => e.name), [entries]);
  const chosen = useMemo(() => entries.filter((e) => selected.includes(e.name)), [entries, selected]);
  /** 只有普通文件参与批量删除（目录是递归删，不能混在批量里）。 */
  const deletable = useMemo(() => chosen.filter((e) => !e.isDir), [chosen]);

  const clear = useCallback(() => {
    setSelected([]);
    setAnchor(null);
  }, []);

  /** 行点击：返回 true 表示「已作为选择处理」，调用方就不该再进入目录。 */
  const pick = useCallback(
    (name: string, e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): boolean => {
      const at = names.indexOf(name);
      if (at < 0) return false;
      if (e.shiftKey && anchor !== null && anchor >= 0 && anchor < names.length) {
        const [lo, hi] = anchor < at ? [anchor, at] : [at, anchor];
        setSelected((prev) => Array.from(new Set([...prev, ...names.slice(lo, hi + 1)])));
        return true;
      }
      if (e.metaKey || e.ctrlKey) {
        setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
        setAnchor(at);
        return true;
      }
      setSelected([name]);
      setAnchor(at);
      return true;
    },
    [anchor, names],
  );

  const selectAll = useCallback(() => setSelected(names), [names]);

  const downloadSelected = useCallback(async () => {
    if (busy || downloading.current) return;
    downloading.current = true;
    try {
      // The download picker/transfer accepts one request at a time; await each one.
      for (const e of chosen) {
        if (!mounted.current) break;
        if (!e.isDir) await onDownload(e.name);
      }
    } finally { downloading.current = false; }
  }, [busy, chosen, onDownload]);

  return {
    selected,
    chosen,
    deletable,
    /** 选中的普通文件数（下载/删除的可用性依据）。 */
    fileCount: deletable.length,
    clear,
    pick,
    selectAll,
    downloadSelected,
    /** 批量删除入口：确认由调用方弹（一次问完，不逐个打扰）。 */
    removeSelected: (confirm: (entries: SshFileEntry[]) => void) => {
      if (busy || deletable.length === 0) return;
      confirm(deletable);
    },
  };
}
