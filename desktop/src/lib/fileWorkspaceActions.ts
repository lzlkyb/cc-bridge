import { invoke } from "./tauri";
import { cancelQueuedSshTransfer, queueSshTransfer } from "./sshTransferQueue";
import { joinRemotePath, remoteParentPath } from "./sshFilePaths";
import { localWorkspaceList, scanWorkspaceTree, type WorkspaceEntry } from "./fileWorkspaceTree";
import type { SshFileEntry } from "./types";

export function formatFileBytes(size: number) {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(1)} ${units[index]}`;
}

type ComparedFile = { size: number; mtime: number };
export async function queueWorkspaceUpload(connectionId: string, local: string, remote: string, label: string, comparison: { source: ComparedFile; destination: ComparedFile | null }, signal: AbortSignal) {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const cancel = () => { void cancelQueuedSshTransfer(id).catch(() => { /* The transfer still reports its actual result. */ }); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await queueSshTransfer({ id, connectionId, label, target: remote, direction: "up", resumable: true }, () => invoke("ssh_sftp_put", { connectionId, local, remote, transferId: id, resumable: true, overwrite: comparison.destination !== null, comparison }));
  } finally { signal.removeEventListener("abort", cancel); }
}

export async function ensureRemoteFolder(connectionId: string, path: string) {
  await invoke("ssh_sftp_mkdir", { connectionId, path });
}

export async function uploadWorkspaceFolder(connectionId: string, remote: string, label: string, entries: WorkspaceEntry[]) {
  const id = crypto.randomUUID();
  return queueSshTransfer({ id, connectionId, label, target: remote, targetKind: "folder", direction: "up" }, async signal => {
    const parent = remoteParentPath(remote);
    const current = await invoke<SshFileEntry[]>("ssh_sftp_list", { connectionId, path: parent });
    signal.throwIfAborted();
    if (current.some(row => row.name === label)) throw Error("远程目录已有同名项，请先更改目标名称");
    const stagingName = `.cc-bridge-${crypto.randomUUID()}.part`;
    const staging = joinRemotePath(parent, stagingName);
    await ensureRemoteFolder(connectionId, staging);
    try {
      // The user-visible directory only appears after all data, including empty directories, is ready.
      for (const dir of entries.filter(row => row.isDir && !row.isSymlink)) {
        signal.throwIfAborted();
        await ensureRemoteFolder(connectionId, joinRemotePath(staging, dir.relative));
      }
      const items = entries.filter(row => !row.isDir && !row.isSymlink).map(row => ({ local: row.path, remote: joinRemotePath(staging, row.relative) }));
      signal.throwIfAborted();
      const count = items.length ? await invoke<number>("ssh_sftp_put_many", { connectionId, transferId: id, items }) : 0;
      signal.throwIfAborted();
      if (count !== items.length) throw Error(`只上传了 ${count} / ${items.length} 个文件`);
      await invoke("ssh_sftp_rename", { connectionId, path: staging, newName: label, overwrite: false });
      return count;
    } catch (error) {
      try { await invoke("ssh_sftp_remove", { connectionId, path: staging }); }
      catch { throw Error(`${String(error)}。临时目录未能清理：${staging}`); }
      throw error;
    }
  });
}

export function scanLocalFolder(path: string) { return scanWorkspaceTree(localWorkspaceList, path, true); }
