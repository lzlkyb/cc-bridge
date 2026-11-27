import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import { toast } from "../ui/toast";
import { cleanErr } from "../../lib/utils";
import { copyUploadName, remoteFileName, joinRemotePath } from "../../lib/sshFilePaths";
import type { SshFileEntry } from "../../lib/types";
import type { SshTransfer } from "./useSshTransfer";
import { useSshDownload } from "../../hooks/useSshDownload";
import { useWorkspaceUpload } from "./useWorkspaceUpload";
import { queueWorkspaceDownload, validLocalDownloadName } from "../../lib/workspaceDownload";

const DOWNLOAD_DIR_KEY = "cc-bridge.download-directory";
type FolderDownload = { dir: string; folders: { remote: string; name: string }[]; enqueue: () => Promise<void> };
interface Params {
  connectionId: string;
  path: string;
  entries: SshFileEntry[];
  xfer: SshTransfer;
  localPath?: string;
  dual?: boolean;
  windows?: boolean;
  onEnqueue?: () => void;
}

export function useSshFileForms({ connectionId, path, entries, xfer, localPath, dual, windows, onEnqueue }: Params) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadLocal, setUploadLocal] = useState("");
  const [folderDownload, setFolderDownload] = useState<FolderDownload | null>(null);
  const [preparingDownload, setPreparingDownload] = useState(false);
  const upload = useWorkspaceUpload(xfer);
  const target = { connectionId, path, existing: entries.map(e => e.name.split(" -> ")[0]) };
  const download = useSshDownload(connectionId, path, xfer.download, windows);
  const preparing = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function chooseDestination(title: string) {
    let defaultPath: string | undefined;
    try { defaultPath = localPath || localStorage.getItem(DOWNLOAD_DIR_KEY) || await downloadDir(); } catch { /* Picker can open without a default. */ }
    const dir = await open({ directory: true, title, defaultPath });
    if (typeof dir !== "string" || !mounted.current) return null;
    try { localStorage.setItem(DOWNLOAD_DIR_KEY, dir); } catch { /* Remembering is optional. */ }
    return dir;
  }

  async function handleDownloadMany(names: string[], choose = false) {
    if (!names.length || preparing.current || folderDownload || download.busy) return;
    preparing.current = true;
    setPreparingDownload(true);
    try {
      const dir = (!choose && dual && localPath) || await chooseDestination("选择本机下载目录");
      if (!dir || !mounted.current) return;
      const folders = names.filter(name => entries.some(row => row.name === name && row.isDir && !row.isSymlink));
      const files = names.filter(name => !folders.includes(name));
      const reserved = new Set<string>();
      const items = await Promise.all(files.map(async source => {
        let name = remoteFileName(source);
        if (!validLocalDownloadName(name, windows)) throw Error(`文件名无法用于本机保存：${name}。请用「另存为」指定名称。`);
        const key = (value: string) => windows ? value.toLowerCase() : value;
        if (reserved.has(key(name))) name = copyUploadName(name);
        reserved.add(key(name));
        return { name, remote: source.startsWith("/") ? source : joinRemotePath(path, source), local: await join(dir, name) };
      }));
      if (!mounted.current) return;
      const sources = folders.map(name => ({ remote: joinRemotePath(path, name), name }));
      let enqueued = false;
      const enqueue = async () => {
        if (enqueued || !mounted.current) return;
        enqueued = true;
        onEnqueue?.();
        try {
          for (const { remote, name } of sources) void queueWorkspaceDownload(connectionId, remote, dir, name, !!windows).catch(reportDownload);
          if (items.length === 1) await xfer.download({ ...items[0], connectionId });
          else if (items.length) await xfer.downloadMany({ connectionId, dir, items });
        } catch (error) { reportDownload(error); }
      };
      if (sources.length) setFolderDownload({ dir, folders: sources, enqueue });
      else await enqueue();
    } catch (error) { reportDownload(error); }
    finally { preparing.current = false; if (mounted.current) setPreparingDownload(false); }
  }

  function handleDownload(name: string) {
    const folder = entries.some(row => row.name === name && row.isDir && !row.isSymlink);
    return dual || folder ? handleDownloadMany([name]) : download.start(name);
  }

  return {
    uploadOpen, setUploadOpen, uploadLocal, setUploadLocal, download, handleDownload, handleDownloadMany,
    folderDownload, preparingDownload, dismissFolderDownload: () => setFolderDownload(null),
    downloadAs: (name: string) => entries.some(row => row.name === name && row.isDir) ? handleDownloadMany([name], true) : download.start(name),
    upload,
    uploadPaths: (paths: string[]) => upload.uploadPaths(target, paths),
    doUpload: async () => {
      if (!uploadLocal.trim()) { toast("请填写本机文件路径", "error"); return; }
      setUploadOpen(false);
      await upload.uploadPaths(target, [uploadLocal.trim()]);
    },
    pickUpload: () => upload.pick(target, false),
    pickFolder: () => upload.pick(target, true),
  };
}

function reportDownload(error: unknown) {
  if (!String(error).includes("CCB_CANCELLED")) toast(`无法下载：${cleanErr(error)}`, "error");
}
