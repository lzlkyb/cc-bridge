import { join } from "@tauri-apps/api/path";
import { invoke } from "./tauri";
import { remoteWorkspaceList, scanWorkspaceTree, type WorkspaceEntry } from "./fileWorkspaceTree";
import { copyUploadName } from "./sshFilePaths";
import { queueSshTransfer, type TransferIssue } from "./sshTransferQueue";
import { isTargetExists } from "./sshErrors";
import { cleanErr } from "./utils";

export function validLocalDownloadName(name: string, windows = false) {
  if (!name || name === "." || name === ".." || /[/\0]/.test(name)) return false;
  if (!windows) return true;
  return !Array.from(name).some(c => c.charCodeAt(0) < 32)
    && !/[<>:"/\\|?*]|[. ]$|^(?:CON|NUL|PRN|AUX|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i.test(name);
}

export function queueWorkspaceDownload(connectionId: string, remote: string, dir: string, name: string, windows: boolean) {
  const id = crypto.randomUUID();
  const rename = new Map<string, string>();
  const completed = new Set<string>();
  const occupied = new Set<string>();
  let plan: WorkspaceEntry[] | undefined;
  let root: string | undefined;
  let activeId: string | undefined;
  let interrupted: { relative: string; id: string } | undefined;
  let skipped = 0;

  function localComponents(relative: string) {
    let path = "";
    return relative.split("/").map(part => {
      path = path ? `${path}/${part}` : part;
      return rename.get(path) ?? part;
    });
  }

  async function prepare(components: string[], exclusive = false) {
    return invoke<string>("ssh_prepare_download_folder", { base: dir, components, exclusive });
  }

  return queueSshTransfer({ id, connectionId, label: name, target: dir, targetKind: "folder", direction: "down",
    transferId: () => activeId ?? interrupted?.id,
    scaleProgress: percent => Math.min(99, Math.floor((completed.size + percent / 100) / (plan?.length || 1) * 100)),
    repair: (path, value) => {
      if (!validLocalDownloadName(value, windows)) throw Error("请输入有效的本机名称");
      rename.set(path, value);
    },
  }, async (signal, report) => {
    if (!plan) {
      const scanned = await scanWorkspaceTree(remoteWorkspaceList(connectionId), remote, true, signal, true);
      skipped = scanned.filter(row => row.isSymlink).length;
      plan = scanned.filter(row => !row.isSymlink);
    }
    signal.throwIfAborted();
    const issues: TransferIssue[] = [];
    const rootName = rename.get("") ?? name;
    if (!validLocalDownloadName(rootName, windows)) {
      report({ issues: [{ path: "", reason: "文件夹名称无法在本机保存", rename: rootName }] });
      return;
    }
    if (!root) {
      let candidate = rootName;
      for (let attempt = 0; attempt < 8; attempt++) {
        signal.throwIfAborted();
        try {
          const target = await prepare([candidate], true);
          root = candidate;
          report({ target });
          break;
        } catch (error) {
          if (!isTargetExists(error)) throw error;
          candidate = copyUploadName(rootName);
        }
      }
      if (!root) throw Error("无法分配下载目录，请更换目标位置");
    }
    const blocked: string[] = [];
    for (const row of plan) {
      signal.throwIfAborted();
      if (completed.has(row.relative) || blocked.some(parent => row.relative.startsWith(parent + "/"))) continue;
      const components = localComponents(row.relative);
      const filename = components[components.length - 1];
      const relative = components.join("/");
      const localKey = windows ? relative.toLowerCase() : relative;
      const collision = occupied.has(localKey);
      if (collision || !validLocalDownloadName(filename, windows)) {
        issues.push({ path: row.relative, reason: collision ? "已保存的项目占用了此名称" : "名称无法在本机保存", rename: filename });
        if (row.isDir) blocked.push(row.relative);
        continue;
      }
      try {
        const parent = await prepare([root, ...(row.isDir ? components : components.slice(0, -1))]);
        signal.throwIfAborted();
        if (!row.isDir) {
          const local = await join(parent, filename);
          signal.throwIfAborted();
          activeId = interrupted?.relative === row.relative ? interrupted.id : crypto.randomUUID();
          await invoke("ssh_sftp_get", { connectionId, remote: row.path, local, transferId: activeId, overwrite: false, resumable: true });
          if (interrupted?.id === activeId) interrupted = undefined;
        }
        completed.add(row.relative);
        occupied.add(localKey);
      } catch (error) {
        signal.throwIfAborted();
        const conflict = isTargetExists(error);
        issues.push({ path: row.relative, reason: cleanErr(error), ...(conflict && { rename: filename }) });
        if (conflict) {
          if (activeId) await invoke("ssh_sftp_cancel", { transferId: activeId }).catch(() => undefined);
          if (interrupted?.id === activeId) interrupted = undefined;
          if (row.isDir) blocked.push(row.relative);
        } else {
          // Resume the interrupted file before starting later files in the directory.
          if (activeId) interrupted = { relative: row.relative, id: activeId };
          break;
        }
      } finally { activeId = undefined; }
      report({ percent: plan.length ? Math.floor(completed.size / plan.length * 100) : 100 });
    }
    signal.throwIfAborted();
    report({ issues, detail: `已保存 ${completed.size} / ${plan.length} 项${skipped ? ` · 跳过 ${skipped} 个符号链接` : ""}` });
  });
}
