import { useCallback, useState } from "react";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { cleanErr } from "../../lib/utils";
import type { SshFileEntry } from "../../lib/types";

/**
 * 后端「目标已存在」标记。三级回退（russh / helper / 一次性 ssh）每一级都返回
 * 这个串；前端判据用 `includes`（错误串前面可能挂着「远程命令失败（退出码 1）」）。
 */
const TARGET_EXISTS = "TARGET_EXISTS";
const targetExists = (e: unknown) => cleanErr(e).includes(TARGET_EXISTS);

/** 覆盖确认弹窗的描述：冲突名 + 重放动作（确认后由这里重新 invoke）。 */
interface OverwritePrompt {
  /** 冲突的目标名（批量时多个，弹窗列清单）。 */
  names: string[];
  /** 展示用：完整目标路径（单条时弹窗给路径框）。 */
  paths?: string[];
  /** 批量冲突才有「跳过」：只执行没冲突的那些。返回失败条数。 */
  onSkip?: () => Promise<number>;
  /** 「覆盖」：重放动作。返回失败条数。 */
  onOverwrite: () => Promise<number>;
}

interface Params {
  connectionId: string;
  /** 当前目录（对话框默认移动到这里；rename 的父目录由后端算，这里只用于拼 from）。 */
  path: string;
  joinRemote: (dir: string, name: string) => string;
  /** 操作成功后刷新列表。 */
  onDone: () => void;
  /** 重命名/移动成功后调用（调用方在这里清多选：旧名字不会自己从 selected 里掉）。 */
  onChanged?: () => void;
}

/**
 * 文件面板的重命名 / 移动（批次③）。
 *
 * 与 `useSshFileOps`（mkdir / 删除）同一模式：一个 busy、成功后刷新、
 * 批量串行执行。差异在**覆盖语义**：rename/move 第一次调用 `overwrite=false`，
 * 后端预检到目标已存在返回 `TARGET_EXISTS`，这里转成覆盖确认弹窗，用户点
 * 「覆盖」才带 `overwrite=true` 重放——没有静默覆盖路径。
 *
 * 批量移动的冲突在移动**之前**用一次列目录本地汇总成一个确认（不逐个弹窗，
 * 也不先移一部分再问——那时用户取消，已移的已经移走了）。
 */
export function useSshFileRename({ connectionId, path, joinRemote, onDone, onChanged }: Params) {
  const [busy, setBusy] = useState(false);
  // 重命名对话框：预填当前名。
  const [renameEntry, setRenameEntry] = useState<SshFileEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  // 移动对话框：单条与批量共用（entries 长度区分）。
  const [moveEntries, setMoveEntries] = useState<SshFileEntry[] | null>(null);
  const [moveDir, setMoveDir] = useState("");
  // 覆盖确认（TARGET_EXISTS 之后）。
  const [overwrite, setOverwrite] = useState<OverwritePrompt | null>(null);

  const openRename = useCallback((entry: SshFileEntry) => {
    setRenameEntry(entry);
    setRenameName(entry.name);
  }, []);
  const closeRename = useCallback(() => setRenameEntry(null), []);

  const submitRename = useCallback(async () => {
    const entry = renameEntry;
    const newName = renameName.trim();
    if (!entry || !newName || busy) return;
    setBusy(true);
    try {
      await invoke("ssh_sftp_rename", {
        connectionId,
        path: joinRemote(path, entry.name),
        new_name: newName,
        overwrite: false,
      });
      toast(`已重命名：${entry.name} → ${newName}`, "success");
      setRenameEntry(null);
      onChanged?.();
      onDone();
    } catch (e) {
      if (targetExists(e)) {
        setOverwrite({
          names: [newName],
          paths: [joinRemote(path, newName)],
          onOverwrite: async () => {
            await invoke("ssh_sftp_rename", {
              connectionId,
              path: joinRemote(path, entry.name),
              new_name: newName,
              overwrite: true,
            });
            return 0;
          },
        });
      } else {
        toast(`重命名失败：${cleanErr(e)}`, "error");
      }
    } finally {
      setBusy(false);
    }
  }, [busy, connectionId, joinRemote, onChanged, onDone, path, renameEntry, renameName]);

  const openMove = useCallback(
    (entries: SshFileEntry[]) => {
      setMoveEntries(entries);
      setMoveDir(path);
    },
    [path],
  );
  const closeMove = useCallback(() => setMoveEntries(null), []);

  /** 串行执行一组移动；逐条失败只 toast 不中断（与批量删除同一模式）。返回失败条数。 */
  const runBatchMove = useCallback(
    async (items: { from: string; name: string }[], toDir: string, overwrite: boolean) => {
      let failed = 0;
      for (const it of items) {
        try {
          await invoke("ssh_sftp_move", { connectionId, from: it.from, to_dir: toDir, overwrite });
        } catch (e) {
          failed++;
          toast(`移动 ${it.name} 失败：${cleanErr(e)}`, "error");
        }
      }
      return failed;
    },
    [connectionId],
  );

  const submitMove = useCallback(async () => {
    const entries = moveEntries;
    const toDir = moveDir.trim();
    if (!entries?.length || !toDir || busy) return;
    setBusy(true);
    try {
      if (entries.length === 1) {
        const from = joinRemote(path, entries[0].name);
        try {
          await invoke("ssh_sftp_move", { connectionId, from, to_dir: toDir, overwrite: false });
          toast(`已移动：${entries[0].name}`, "success");
          setMoveEntries(null);
          onChanged?.();
          onDone();
        } catch (e) {
          if (targetExists(e)) {
            setOverwrite({
              names: [entries[0].name],
              paths: [joinRemote(toDir, entries[0].name)],
              onOverwrite: async () => {
                await invoke("ssh_sftp_move", { connectionId, from, to_dir: toDir, overwrite: true });
                return 0;
              },
            });
          } else {
            toast(`移动失败：${cleanErr(e)}`, "error");
          }
        }
        return;
      }
      // 批量：先列目标目录，冲突在本地汇总成一个确认。列目录失败（目录不存在等）
      // 直接让整个批量失败——一个都没移，比移一半再报错好收拾。
      const listing = await invoke<SshFileEntry[]>("ssh_sftp_list", { connectionId, path: toDir });
      const existing = new Set(listing.map((e) => e.name));
      const items = entries.map((e) => ({ from: joinRemote(path, e.name), name: e.name }));
      const conflicts = items.filter((it) => existing.has(it.name));
      const fresh = items.filter((it) => !existing.has(it.name));
      if (conflicts.length > 0) {
        setOverwrite({
          names: conflicts.map((c) => c.name),
          onSkip: async () => runBatchMove(fresh, toDir, false),
          onOverwrite: async () => {
            await runBatchMove(conflicts, toDir, true);
            return runBatchMove(fresh, toDir, false);
          },
        });
        return;
      }
      const failed = await runBatchMove(items, toDir, false);
      if (failed === 0) toast(`已移动 ${items.length} 个条目`, "success");
      setMoveEntries(null);
      onChanged?.();
      onDone();
    } catch (e) {
      // 只有批量路径的列目录失败会到这里（单条路径自己 catch 并 toast 了）。
      toast(`移动失败：${cleanErr(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [busy, connectionId, joinRemote, moveDir, moveEntries, onChanged, onDone, path, runBatchMove]);

  const confirmOverwrite = useCallback(async () => {
    const prompt = overwrite;
    if (!prompt || busy) return;
    setBusy(true);
    try {
      const failed = await prompt.onOverwrite();
      if (failed === 0) {
        toast(
          prompt.names.length === 1 ? `已覆盖：${prompt.names[0]}` : `已覆盖 ${prompt.names.length} 个目标`,
          "success",
        );
      }
      // 失败也收摊：逐条错误已经 toast 过，留着弹窗只会让人反复点同一个坏按钮。
      setOverwrite(null);
      setRenameEntry(null);
      setMoveEntries(null);
      onChanged?.();
      onDone();
    } finally {
      setBusy(false);
    }
  }, [busy, onChanged, onDone, overwrite]);

  const skipConflicts = useCallback(async () => {
    const prompt = overwrite;
    if (!prompt?.onSkip || busy) return;
    setBusy(true);
    try {
      const failed = await prompt.onSkip();
      if (failed === 0) toast("已跳过同名目标，其余已移动", "success");
      setOverwrite(null);
      setMoveEntries(null);
      onChanged?.();
      onDone();
    } finally {
      setBusy(false);
    }
  }, [busy, onChanged, onDone, overwrite]);

  const cancelOverwrite = useCallback(() => setOverwrite(null), []);

  return {
    busy,
    renameEntry,
    renameName,
    setRenameName,
    openRename,
    closeRename,
    submitRename,
    moveEntries,
    moveDir,
    setMoveDir,
    openMove,
    closeMove,
    submitMove,
    overwrite,
    confirmOverwrite,
    skipConflicts,
    cancelOverwrite,
  };
}
