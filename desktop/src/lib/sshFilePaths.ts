import type { SshFileEntry } from "./types";

/** Remote paths are POSIX paths; never append their directory components to a local filename. */
export function remoteFileName(path: string): string { return path.replace(/\/+$/, "").split("/").pop() || "download"; }
export function remoteParentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}
export function isInitialFileListing(path: string, entries: SshFileEntry[]): boolean {
  return entries.length === 1 && !entries[0].isDir && entries[0].name === path && path.startsWith("/");
}
