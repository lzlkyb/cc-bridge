import { useCallback, useState } from "react";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { cleanErr } from "../../lib/utils";
import type { SshFileEntry } from "../../lib/types";

/**
 * 文件面板的「瞬时操作」：新建文件夹与删除。
 *
 * 从 SshFileBrowser 拆出（体量棘轮）：这批状态自成一体——都只有一个 busy 标志、
 * 都要在完成后刷新列表、都不参与目录导航。留在大组件里会让它同时背着
 * 「导航 / 传输 / 瞬时操作 / 编辑器开关」四套生命周期。
 *
 * 删除走项目内 Dialog 二次确认（`targets` 非空即弹），批量时一次问完、串行执行
 * （本机 OpenSSH 不支持连接复用，并发只是把握手成本乘以 N）。
 */
export function useSshFileOps({
  connectionId,
  path,
  joinRemote,
  onDone,
  onRemoved,
}: {
  connectionId: string;
  path: string;
  joinRemote: (dir: string, name: string) => string;
  onDone: () => void;
  /** 删除成功后调用（调用方在这里清多选：失效名字不会自己从 `selected` 里掉）。 */
  onRemoved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const [targets, setTargets] = useState<(SshFileEntry & { remotePath: string })[]>([]);

  const doMkdir = useCallback(async () => {
    if (busy || !mkdirName.trim()) return;
    setBusy(true);
    try {
      await invoke("ssh_sftp_mkdir", {
        connectionId,
        path: joinRemote(path, mkdirName.trim()),
      });
      toast("已创建文件夹", "success");
      setMkdirOpen(false);
      setMkdirName("");
      onDone();
    } catch (e) {
      toast(`创建失败：${cleanErr(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [busy, connectionId, joinRemote, mkdirName, onDone, path]);

  const confirmRemove = useCallback(async () => {
    if (!targets.length || busy) return;
    const list = targets;
    setTargets([]);
    setBusy(true);
    let failed = 0;
    try {
      for (const e of list) {
        try {
          await invoke("ssh_sftp_remove", { connectionId, path: e.remotePath });
        } catch (err) {
          failed++;
          toast(`删除 ${e.name} 失败：${cleanErr(err)}`, "error");
        }
      }
      if (failed === 0) {
        toast(list.length === 1 ? `已删除：${list[0].name}` : `已删除 ${list.length} 个文件`, "success");
        onRemoved?.();
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }, [busy, connectionId, onDone, onRemoved, targets]);

  const toggleMkdir = useCallback(() => {
    setMkdirOpen((v) => !v);
    setMkdirName("");
  }, []);

  return {
    busy,
    mkdirOpen,
    mkdirName,
    setMkdirName,
    toggleMkdir,
    targets,
    setTargets,
    doMkdir,
    confirmRemove,
  };
}
