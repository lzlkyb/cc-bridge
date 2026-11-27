import { invoke } from "./tauri";
import { joinRemotePath } from "./sshFilePaths";
import type { BrowseResult, SshFileEntry } from "./types";

export interface WorkspaceEntry {
  path: string;
  relative: string;
  isDir: boolean;
  size: number | null;
  mtime: number | null;
  isSymlink?: boolean;
}

type Entry = Omit<WorkspaceEntry, "relative"> & { name: string; isSymlink?: boolean };
type List = (path: string) => Promise<Entry[]>;

export async function listLocalWorkspace(path: string) {
  return invoke<BrowseResult>("browse_directory", { path, includeFiles: true });
}

export const localWorkspaceList: List = async path => (await listLocalWorkspace(path)).entries.map(row => ({
  ...row, size: row.size ?? null, mtime: row.mtime ?? null,
}));

export const remoteWorkspaceList = (connectionId: string): List => async path => (
  await invoke<SshFileEntry[]>("ssh_sftp_list", { connectionId, path })
).map(row => ({ ...row, path: joinRemotePath(path, row.name) }));

export async function scanWorkspaceTree(list: List, root: string, recursive: boolean, signal?: AbortSignal, preservePosixNames = false) {
  const directories = [{ path: root, prefix: "" }];
  const entries: WorkspaceEntry[] = [];
  for (const dir of directories) {
    signal?.throwIfAborted();
    const rows = await list(dir.path);
    signal?.throwIfAborted();
    for (const { name, isSymlink, ...row } of rows) {
      if (!name || name === "." || name === ".." || name.includes("/") || (!preservePosixNames && name.includes("\\")) || /^\.cc-bridge-[\da-f-]{36}\.part$/i.test(name)) continue;
      const relative = dir.prefix + name;
      entries.push({ ...row, relative, isSymlink });
      if (recursive && row.isDir && !isSymlink) directories.push({ path: row.path, prefix: `${relative}/` });
      if (entries.length > 5000 || directories.length > 100) {
        // Applying changes from a partial comparison could delete files that were never scanned.
        throw Error("目录范围太大，请进入更具体的目录后重试（最多 5,000 项或 100 个目录）");
      }
    }
  }
  return entries;
}

export type WorkspaceChange = WorkspaceEntry & { kind: "upload" | "replace" | "remove"; previous?: Pick<WorkspaceEntry, "size" | "mtime"> };
export function compareWorkspaceTrees(local: WorkspaceEntry[], remote: WorkspaceEntry[]): WorkspaceChange[] {
  const byLocal = new Map(local.map(row => [row.relative, row]));
  const byRemote = new Map(remote.map(row => [row.relative, row]));
  const links = [...local, ...remote].filter(row => row.isSymlink).map(row => row.relative);
  const linked = (path: string) => links.some(link => path === link || path.startsWith(`${link}/`));
  return [
    ...local.flatMap((row): WorkspaceChange[] => {
      if (linked(row.relative)) return [];
      const other = byRemote.get(row.relative);
      if (!other) return row.isDir ? [] : [{ ...row, kind: "upload" }];
      if (row.isDir !== other.isDir) throw Error(`同名文件与目录冲突：${row.relative}`);
      if (row.isDir || (row.size !== null && row.size === other.size && row.mtime !== null && row.mtime === other.mtime)) return [];
      return [{ ...row, kind: "replace", previous: { size: other.size, mtime: other.mtime } }];
    }),
    ...remote.filter(row => !row.isDir && !byLocal.has(row.relative) && !linked(row.relative)).map(row => ({ ...row, kind: "remove" as const })),
  ];
}
