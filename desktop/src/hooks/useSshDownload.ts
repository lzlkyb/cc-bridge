import { useEffect, useRef, useState } from "react";
import { downloadDir, dirname, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { cleanErr } from "../lib/utils";
import { remoteFileName } from "../lib/sshFilePaths";
import type { StartArgs } from "../lib/transferTypes";
import type { useSshTransfer } from "../components/tabs/useSshTransfer";
import { toast } from "../components/ui/toast";

const DIRECTORY_KEY = "cc-bridge.download-directory";
export interface DownloadResult { args: StartArgs; status: "done" | "failed" | "cancelled"; error?: string; }

/** Native save selection and recoverable results; the transfer hook retains overwrite/cancel protection. */
export function useSshDownload(connectionId: string, path: string, download: ReturnType<typeof useSshTransfer>["download"]) {
  const [choosing, setChoosing] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const locked = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (args: StartArgs) => {
    if (mounted.current) { setRunning(true); setResult(null); }
    let error: string | undefined;
    try {
      const ok = await download(args, message => { error = message; }, true);
      if (mounted.current) setResult({args, status: ok ? "done" : error ? "failed" : "cancelled", error});
    } finally { if (mounted.current) setRunning(false); }
  };
  const start = async (name: string) => {
    if (locked.current) return;
    locked.current = true; setChoosing(true);
    const filename = remoteFileName(name);
    const remote = name.startsWith("/") ? name : `${path.replace(/\/$/, "")}/${name}`;
    try {
      let defaultPath = filename;
      try { defaultPath = await join(localStorage.getItem(DIRECTORY_KEY) || await downloadDir(), filename); } catch { /* Native picker can choose a location without a default directory. */ }
      const local = await save({title:"下载文件到本机", defaultPath});
      if (!local || !mounted.current) return;
      try { localStorage.setItem(DIRECTORY_KEY, await dirname(local)); } catch { /* Remembering a folder must not prevent the download. */ }
      if (!mounted.current) return;
      setChoosing(false);
      await run({connectionId, name:filename, remote, local});
    } catch (error) { if (mounted.current) toast(`无法开始下载：${cleanErr(error)}`, "error"); }
    finally { locked.current = false; if (mounted.current) setChoosing(false); }
  };
  const retry = async () => {
    if (!result || locked.current) return;
    locked.current = true;
    try { await run(result.args); } finally { locked.current = false; }
  };
  return {start, retry, choosing, busy:choosing || running, result, clear:() => setResult(null)};
}
