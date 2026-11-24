import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import { toast } from "../components/ui/toast";
import { cleanErr } from "../lib/utils";

/** 后端 `ssh_file_read` 的返回（camelCase）。 */
export interface RemoteFileContent {
  content: string;
  size: number;
  mtime: number;
  truncated: boolean;
  lineEnding: string;
  /** 原文件编码标签："utf-8" | "gbk"。保存时原样带回，按此编码落盘
   * （不带回会把 GBK 文件静默转码成 UTF-8）。 */
  encoding: string;
}

/** 后端 `ssh_file_write` / `ssh_file_upload_edited` 的返回。 */
export interface RemoteFileWrite {
  mtime: number;
  size: number;
}

/** 远端被改的前缀（后端 `ERR_FILE_CONFLICT`）。 */
const CONFLICT = "CCB_FILE_CONFLICT";
/** 非 UTF-8 前缀（后端 `ERR_FILE_BINARY`）。 */
const BINARY = "CCB_FILE_BINARY";

/**
 * 判错误是否属于某类。用 `includes` 而不是 `startsWith`：Tauri 的 `Err(String)`
 * 过来就是纯串，但被包成 `Error` 对象时 `String(e)` 会多一个 `Error: ` 前缀，
 * `startsWith` 就静默失效了（冲突条不出现，用户只看到一条看不懂的 toast）。
 * 标记串本身足够独特，`includes` 不会误判。
 */
function errIs(e: unknown, marker: string): boolean {
  return cleanErr(e).includes(marker);
}

export type EditPhase = "loading" | "ready" | "saving" | "opening";

interface Options {
  connectionId: string;
  path: string;
  /** 用本机编辑器打开成功后的回调（父层可关闭覆盖层）。 */
  onExternalOpened?: (info: { localPath: string; mtime: number }) => void;
}

/**
 * 远程文件编辑的状态机：读 → 改 → 存，外加「远端被改」与「用本机编辑器打开」。
 *
 * 冲突不在 hook 里弹窗（R17），而是置 `conflict` 标志，由 UI 渲染内联条给
 * 「重新加载 / 仍然覆盖保存」两条出路——和删除/覆盖确认一样是显式交互，
 * 但不打断编辑上下文。
 */
export function useRemoteFileEdit({ connectionId, path, onExternalOpened }: Options) {
  const [phase, setPhase] = useState<EditPhase>("loading");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [baseline, setBaseline] = useState("");
  const [meta, setMeta] = useState<Omit<RemoteFileContent, "content"> | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 大文件只读：读回来就是截断的，禁止编辑而不是让用户改一半存不回去。
  const readOnly = !!meta?.truncated;
  const externalCb = useRef(onExternalOpened);
  externalCb.current = onExternalOpened;
  // baseline 用 ref 供 onChange 读：写进 useCallback 依赖的话，每次保存后
  // baseline 变 → onChange 引用变 → CodeMirrorHost 重建编辑器（丢光标与撤销栈）。
  const baselineRef = useRef("");
  baselineRef.current = baseline;

  const load = useCallback(
    async (force = false) => {
      setPhase("loading");
      setError(null);
      try {
        const r = await invoke<RemoteFileContent>("ssh_file_read", { connectionId, path });
        setContent(r.content);
        setBaseline(r.content);
        setDirty(false);
        setConflict(false);
        setMeta({
          size: r.size,
          mtime: r.mtime,
          truncated: r.truncated,
          lineEnding: r.lineEnding,
          encoding: r.encoding,
        });
        setPhase("ready");
      } catch (e) {
        if (errIs(e, BINARY)) {
          // 二进制：本 hook 不猜怎么打开，交给 UI 提示「用本机编辑器打开」。
          setError("binary");
        } else {
          setError(cleanErr(e));
        }
        setPhase("ready");
        if (force) toast(`重新加载失败：${cleanErr(e)}`, "error");
      }
    },
    [connectionId, path],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (force: boolean) => {
      if (!meta || readOnly) return;
      setPhase("saving");
      setError(null);
      try {
        const r = await invoke<RemoteFileWrite>("ssh_file_write", {
          connectionId,
          path,
          content,
          lineEnding: meta.lineEnding,
          encoding: meta.encoding,
          expectedMtime: meta.mtime,
          force,
        });
        setBaseline(content);
        setDirty(false);
        setConflict(false);
        setMeta((m) => (m ? { ...m, mtime: r.mtime, size: r.size } : m));
        setPhase("ready");
        toast("已保存", "success");
      } catch (e) {
        setPhase("ready");
        if (errIs(e, CONFLICT)) {
          // 远端被改：不丢用户的修改，只标冲突，出路由 UI 给。
          setConflict(true);
        } else {
          setError(cleanErr(e));
          toast(`保存失败：${cleanErr(e)}`, "error");
        }
      }
    },
    [connectionId, path, content, meta, readOnly],
  );

  const reload = useCallback(async () => {
    await load(true);
  }, [load]);

  /** C 路线：scp 到本机临时副本并用系统默认应用打开。 */
  const openExternal = useCallback(async () => {
    setPhase("opening");
    setError(null);
    try {
      const r = await invoke<{ localPath: string; mtime: number }>("ssh_file_open_external", {
        connectionId,
        path,
      });
      externalCb.current?.(r);
      toast("已用本机编辑器打开，编辑后点「回传」", "success");
      setPhase("ready");
    } catch (e) {
      setError(cleanErr(e));
      toast(`打开失败：${cleanErr(e)}`, "error");
      setPhase("ready");
    }
  }, [connectionId, path]);

  const onChange = useCallback((next: string) => {
    setContent(next);
    setDirty(next !== baselineRef.current);
  }, []);

  return {
    phase,
    content,
    dirty,
    meta,
    readOnly,
    conflict,
    error,
    load,
    save,
    reload,
    openExternal,
    onChange,
  };
}
