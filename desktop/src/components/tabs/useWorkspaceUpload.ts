import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "../../lib/tauri";
import { scanLocalFolder, uploadWorkspaceFolder } from "../../lib/fileWorkspaceActions";
import { copyUploadName, joinRemotePath } from "../../lib/sshFilePaths";
import { cleanErr } from "../../lib/utils";
import { toast } from "../ui/toast";
import type { SshTransfer } from "./useSshTransfer";

type LocalItem = { path: string; name: string; isDir: boolean; exists: boolean };
type FolderPlan = { local: string; name: string };
type Target = { connectionId: string; path: string; existing?: string[] };
type Plan = { target: Target; folders: FolderPlan[]; files: { local: string; name: string }[] };

export function useWorkspaceUpload(xfer: SshTransfer) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function sendFiles({ target, files }: Plan) {
    if (files.length === 1 && target.existing) {
      const { local, name } = files[0];
      await xfer.upload({ connectionId: target.connectionId, local, name, remote: joinRemotePath(target.path, name),
        remoteExists: target.existing.includes(name) });
    } else if (files.length) {
      const result = await xfer.uploadMany({ connectionId: target.connectionId, dir: target.path, existing: target.existing, files });
      if (result.done) toast(`已上传 ${result.done} 个文件`, "success");
    }
  }

  async function prepare(target: Target, paths: string[]) {
    if (!paths.length || !mounted.current) return;
    const entries = await invoke<LocalItem[]>("local_path_info", { paths });
    if (!mounted.current) return;
    const missing = entries.filter(row => !row.exists);
    if (missing.length) toast(`无法读取：${missing.map(row => row.name).join("、")}`, "warning");
    const files = entries.filter(row => row.exists && !row.isDir).map(row => ({ local: row.path, name: row.name }));
    const folders = entries.filter(row => row.exists && row.isDir).map(row => {
      const name = target.existing?.includes(row.name) ? copyUploadName(row.name) : row.name;
      return { local: row.path, name };
    });
    const next = { target, files, folders };
    if (folders.length) setPlan(next);
    else await sendFiles(next);
  }

  async function run(action: () => Promise<void>) {
    if (locked.current || plan) return;
    locked.current = true;
    setBusy(true);
    try { await action(); }
    catch (error) { toast(`无法上传：${cleanErr(error)}`, "error"); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }

  function pick(target: Target, directory: boolean) {
    return run(async () => {
      const chosen = await open({ directory, multiple: !directory, title: directory ? "选择要上传的文件夹" : "选择要上传的文件" });
      if (chosen) await prepare(target, Array.isArray(chosen) ? chosen : [chosen]);
    });
  }

  const invalid = !!plan && (plan.folders.some(({name}) => !name || name === "." || name === ".." || /[\\/\0\r\n]/.test(name)) ||
    new Set(plan.folders.map(row => row.name)).size !== plan.folders.length);

  async function submit() {
    if (!plan || invalid || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const prepared = [];
      for (const folder of plan.folders) prepared.push({ ...folder, entries: await scanLocalFolder(folder.local) });
      if (!mounted.current) return;
      setPlan(null);
      const tasks = prepared.map(folder => uploadWorkspaceFolder(plan.target.connectionId,
        joinRemotePath(plan.target.path, folder.name), folder.name, folder.entries));
      await Promise.allSettled([...tasks, sendFiles(plan)]);
    } catch (error) { toast(`无法整理上传文件夹：${cleanErr(error)}`, "error"); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }

  return {
    busy, plan, invalid, pick, submit,
    uploadPaths: (target: Target, paths: string[]) => run(() => prepare(target, paths)),
    rename: (idx: number, name: string) => setPlan(current => current && ({ ...current,
      folders: current.folders.map((folder, i) => i === idx ? { ...folder, name } : folder),
    })),
    dismiss: () => { if (!locked.current) setPlan(null); },
  };
}
