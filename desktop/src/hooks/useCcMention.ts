import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import type { BrowseEntry, SshFileEntry, StatusResponse } from "../lib/types";
import {
  filterMentionItems,
  insertMention,
  mentionTokenOf,
  remoteChildPath,
  typedSegments,
  type MentionItem,
} from "../lib/ccMention";

/**
 * @引用补全的状态与取数（设计稿《对话页-@引用与排版偏好》）。
 *
 * 解析模型：**面板层级完全由已打的 token 推导**——`@desktop/src/ccM` 会被
 * 逐段下钻（desktop → src，每段一次列目录），末段当过滤器。选中目录 = 把
 * token 续写成 `@路径/`（下钻由同一解析自动完成），选中文件 = `@路径␠` 结束。
 * 好处：面板状态没有「用户点出来的层级」这第二种真相源，光标里打什么就是什么。
 *
 * 层级来源：
 * - 本机：根层 = 白名单根 + 本会话目录置顶；下钻走 browse_directory(include_files)。
 *   （打绝对路径不下钻 —— 根层的展示名不是路径前缀，v1 已知限制。）
 * - 远端：根层 = 本会话 cwd（远端没有「白名单」概念）；打 `/` 开头则从 `/` 下钻；
 *   列目录走 ssh_sftp_list（本来就带文件与大小）。
 *
 * 取数用 queryClient.fetchQuery（去重 + 5s 缓存，rapid 键入不重复发请求），
 * 下钻链带 epoch 防乱序（慢响应晚到不得覆盖新层级）。
 */
export function useCcMention({
  value,
  setValue,
  connectionId,
  cwd,
}: {
  value: string;
  setValue: (v: string) => void;
  /** "" = 本机目标。 */
  connectionId: string;
  /** 本会话工作目录（本机路径或远端路径）。 */
  cwd: string;
}) {
  const queryClient = useQueryClient();
  const caretRef = useRef(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [level, setLevel] = useState<{ dir: string | null; items: MentionItem[]; filter: string }>({
    dir: null,
    items: [],
    filter: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epochRef = useRef(0);

  const token = mentionTokenOf(value, caretRef.current);
  const open = !!token && !dismissed;
  const query = token?.query ?? "";

  // 与 App 共用 ["status"] 缓存（不多发请求），只取白名单根。
  const { data: status } = useQuery<StatusResponse>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
  });
  const roots = useMemo<MentionItem[]>(() => {
    if (connectionId) return [];
    const nameOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
    const list = (status?.allowedRoots ?? []).map((p) => ({ name: nameOf(p), path: p, isDir: true }));
    if (!cwd) return list;
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    const dup = list.some((it) => norm(it.path) === norm(cwd));
    return dup
      ? [
          { name: nameOf(cwd), path: cwd, isDir: true, tag: "本会话目录" },
          ...list.filter((it) => norm(it.path) !== norm(cwd)),
        ]
      : [{ name: nameOf(cwd), path: cwd, isDir: true, tag: "本会话目录" }, ...list];
  }, [status?.allowedRoots, cwd, connectionId]);

  const listDir = useCallback(
    async (path: string): Promise<MentionItem[]> => {
      if (!connectionId) {
        const r = await queryClient.fetchQuery({
          queryKey: ["ccMention", "local", path],
          queryFn: () =>
            invoke<{ entries: BrowseEntry[] }>("browse_directory", { path, includeFiles: true }),
          staleTime: 5000,
        });
        return r.entries.map((e) => ({ name: e.name, path: e.path, isDir: e.isDir }));
      }
      const rows = await queryClient.fetchQuery({
        queryKey: ["ccMention", connectionId, path],
        queryFn: () => invoke<SshFileEntry[]>("ssh_sftp_list", { connectionId, path }),
        staleTime: 5000,
      });
      return rows
        .filter((r) => r.name !== "." && r.name !== "..")
        .map((r) => ({ name: r.name, path: remoteChildPath(path, r.name), isDir: r.isDir, size: r.size }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    },
    [connectionId, queryClient],
  );

  // 层级解析：token 变化 → 逐段下钻。epoch 防慢响应乱序回写旧层级。
  useEffect(() => {
    if (!open) {
      setLevel({ dir: null, items: [], filter: "" });
      setError(null);
      setLoading(false);
      return;
    }
    const epoch = ++epochRef.current;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        let dir: string | null = null;
        let items: MentionItem[];
        let segs = typedSegments(query);
        if (connectionId) {
          dir = query.startsWith("/") ? "/" : cwd || "/";
          items = await listDir(dir);
        } else {
          items = roots;
          // 路径前缀跳级：选中目录续写（@D:\work/）与手打绝对路径都命中这里 ——
          // 按名字逐段走的话，首段「D:」永远对不上根名。取前缀最长的根。
          const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
          const typed = query.replace(/[\\/]+$/, "").toLowerCase();
          const hit = roots
            .filter((r) => {
              const n = norm(r.path);
              return typed.startsWith(n) && (typed.length === n.length || /[\\/]/.test(typed[n.length] ?? ""));
            })
            .sort((a, b) => b.path.length - a.path.length)[0];
          if (hit) {
            segs = typedSegments(query.slice(hit.path.length));
            dir = hit.path;
            items = await listDir(hit.path);
          }
        }
        for (let i = 0; i + 1 < segs.length; i++) {
          const seg = segs[i];
          const child = items.find(
            (it) => it.isDir && (it.name === seg || it.name.toLowerCase() === seg.toLowerCase()),
          );
          if (!child) break;
          items = await listDir(child.path);
          dir = child.path;
        }
        if (cancelled || epoch !== epochRef.current) return;
        setLevel({ dir, items, filter: segs[segs.length - 1] ?? "" });
      } catch (e) {
        if (!cancelled && epoch === epochRef.current) setError(String(e));
      } finally {
        if (!cancelled && epoch === epochRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, query, roots, connectionId, cwd, listDir]);

  const items = useMemo(() => filterMentionItems(level.items, level.filter), [level]);
  useEffect(() => {
    setActive(0);
  }, [query, level.dir]);

  // 与 slash 面板同一模式：Esc 后下一次输入重置 dismissed（保持两套浮层行为一致）。
  useEffect(() => {
    setDismissed(false);
  }, [value]);

  const syncCaret = useCallback((caret: number) => {
    caretRef.current = caret;
  }, []);

  const pick = useCallback(
    (item: MentionItem) => {
      const t = mentionTokenOf(value, caretRef.current);
      if (!t) return;
      const suffix = item.isDir ? "/" : " ";
      const next = insertMention(value, t.start, caretRef.current, item.path, suffix);
      // 🔴 caretRef 必须跟着推进：程序化 setValue 不触发 select 事件，浏览器也不一定
      //    把光标放到插入终点 —— ref 停在旧位置会让下一次解析把 token 判成空查询。
      caretRef.current = t.start + 1 + item.path.length + suffix.length;
      setValue(next);
      setActive(0);
    },
    [value, setValue],
  );

  /** 键盘处理：true = 已消费（Composer 直接 return）。焦点始终在 textarea。 */
  const handleKey = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (e.key === "Escape") {
        setDismissed(true);
        return true;
      }
      if (items.length === 0) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (e.key === "ArrowDown" ? (a + 1) % items.length : (a - 1 + items.length) % items.length));
        return true;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        pick(items[Math.min(active, items.length - 1)]);
        return true;
      }
      return false;
    },
    [open, items, active, pick],
  );

  return {
    open,
    items,
    active: Math.min(active, Math.max(0, items.length - 1)),
    crumb: level.dir,
    filter: level.filter,
    loading,
    error,
    handleKey,
    pick,
    hover: setActive,
    syncCaret,
  };
}
