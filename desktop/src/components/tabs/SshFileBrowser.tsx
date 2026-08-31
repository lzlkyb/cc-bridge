import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { downloadDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { isMac } from "../../lib/platform";
import { toast } from "../ui/toast";
import type { SshConnection, SshFileEntry } from "../../lib/types";
import { FileTable } from "./SshFileRow";
import { MkdirForm, UploadForm, DownloadForm } from "./SshFileForms";
import { FileHeader, RemoveConfirmDialog } from "./SshFileToolbar";
import { cleanErr, useSshTransfer } from "./useSshTransfer";
import { OverwriteConfirmDialog, TransferBar } from "./SshTransferBar";

interface Props {
  conn: SshConnection;
  onBack: () => void;
}

/** 远程路径拼接（Linux 风格）。 */
function joinRemote(dir: string, name: string): string {
  if (dir === "/" || dir === "") return "/" + name;
  return dir.replace(/\/$/, "") + "/" + name;
}
/** 远程父目录。 */
function parentRemote(dir: string): string {
  if (dir === "/" || dir === "") return "/";
  const trimmed = dir.replace(/\/$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/**
 * SFTP 文件管理器：列目录 / 进入 / 上一级 / 下载 / 上传 / 新建文件夹 / 删除。
 * 走后端 `ssh_sftp_*` 命令（ssh 跑远程命令 + scp 传文件，PTY 自动填凭据）。
 * 本机路径用内联文本框输入（不依赖系统文件选择器插件）。
 */
export function SshFileBrowser({ conn, onBack }: Props) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<SshFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 传输态交给 useSshTransfer 管，这里只管 mkdir / 删除这类瞬时操作。
  const [busyOp, setBusyOp] = useState(false);
  // 上传：本机源文件路径。
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadLocal, setUploadLocal] = useState("");
  // 新建文件夹名。
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  // 下载目标：entry.name -> 本机目标路径。
  const [downloadFor, setDownloadFor] = useState<string | null>(null);
  const [downloadLocal, setDownloadLocal] = useState("");
  // 删除确认：待删除条目（项目内 Dialog 二次确认，避免 window.confirm 与 Tauri 风格割裂）。
  const [removeTarget, setRemoveTarget] = useState<SshFileEntry | null>(null);

  // 平台标识用于切换占位文案（mac 显示 POSIX 路径，Windows 显示盘符路径）。
  // get_status 是全局缓存的查询，这里复用不会多开连接。
  const { data: status } = useQuery({
    queryKey: ["get_status"],
    queryFn: () => invoke<{ platform?: string }>("get_status"),
  });
  const mac = isMac(status?.platform);
  const xfer = useSshTransfer();
  // 传输进行中也算忙：期间禁掉新建/上传/删除，避免并发多条 ssh 握手
  // （本机 OpenSSH 不支持连接复用，并发只会把握手成本乘以 N）。
  const busy = busyOp || !!xfer.transfer;

  const list = useCallback(
    async (p: string) => {
      setLoading(true);
      setError(null);
      try {
        const r = await invoke<SshFileEntry[]>("ssh_sftp_list", {
          connectionId: conn.id,
          path: p,
        });
        const sorted = [...r].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(sorted);
      } catch (e) {
        setError(`列目录失败：${cleanErr(e)}`);
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [conn.id],
  );

  useEffect(() => {
    void list(path);
  }, [list, path]);

  const openDir = (name: string) => setPath(joinRemote(path, name));

  // 点击下载：展开下载表单并预填本机下载目录下的同名文件（用 path::join 而非
  // 字符串拼，避免 macOS 上 downloadDir() 末尾无分隔符拼成错路径）。
  const handleDownload = (name: string) => {
    setDownloadFor(name);
    void (async () => {
      try {
        setDownloadLocal(await join(await downloadDir(), name));
      } catch {
        setDownloadLocal(name);
      }
    })();
  };

  const doDownload = async (name: string) => {
    if (!downloadLocal.trim()) {
      toast("请填写本机保存路径", "error");
      return;
    }
    // 进度 / 取消 / 覆盖确认全在 useSshTransfer 里；目标已存在时它会先弹确认框，
    // 确认后重跑，整个流程走完才 resolve——所以这里 await 到的是最终结果。
    const ok = await xfer.download({
      connectionId: conn.id,
      name,
      remote: joinRemote(path, name),
      local: downloadLocal.trim(),
    });
    if (ok) {
      setDownloadFor(null);
      setDownloadLocal("");
    }
  };

  const doUpload = async () => {
    if (!uploadLocal.trim()) {
      toast("请选择或填写本机文件路径", "error");
      return;
    }
    const base = uploadLocal.trim().replace(/\\/g, "/").split("/").pop() || "file";
    // 重名判定在前端：当前目录的 entries 手里已经有，在后端再查一次
    // 就多一次完整的 ssh 握手。
    const ok = await xfer.upload({
      connectionId: conn.id,
      name: base,
      local: uploadLocal.trim(),
      remote: joinRemote(path, base),
      remoteExists: entries.some((e) => e.name === base),
    });
    if (ok) {
      setUploadOpen(false);
      setUploadLocal("");
      void list(path);
    }
  };

  // 用系统文件选择器选本机文件（拿到真实绝对路径，scp 才能读取）。
  const pickUpload = async () => {
    try {
      const selected = await open({
        multiple: false,
        title: "选择要上传的文件",
      });
      if (typeof selected === "string") {
        setUploadLocal(selected);
      }
    } catch {
      /* 用户取消或无选择器权限，忽略 */
    }
  };

  const doMkdir = async () => {
    if (!mkdirName.trim()) return;
    setBusyOp(true);
    try {
      await invoke("ssh_sftp_mkdir", {
        connectionId: conn.id,
        path: joinRemote(path, mkdirName.trim()),
      });
      toast("已创建文件夹", "success");
      setMkdirOpen(false);
      setMkdirName("");
      void list(path);
    } catch (e) {
      toast(`创建失败：${cleanErr(e)}`, "error");
    } finally {
      setBusyOp(false);
    }
  };

  const confirmRemove = async () => {
    const e = removeTarget;
    if (!e) return;
    setRemoveTarget(null);
    setBusyOp(true);
    try {
      await invoke("ssh_sftp_remove", {
        connectionId: conn.id,
        path: joinRemote(path, e.name),
      });
      toast(`已删除：${e.name}`, "success");
      void list(path);
    } catch (err) {
      toast(`删除失败：${cleanErr(err)}`, "error");
    } finally {
      setBusyOp(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部：返回 + 连接信息 + 操作 + 路径条 */}
      <FileHeader
        conn={conn}
        path={path}
        loading={loading}
        busy={busy}
        onBack={onBack}
        onUp={() => setPath(parentRemote(path))}
        onRefresh={() => void list(path)}
        onNewFolder={() => {
          setMkdirOpen((v) => !v);
          setMkdirName("");
        }}
        onUpload={() => {
          setUploadOpen((v) => !v);
          setUploadLocal("");
        }}
      />

      {/* 新建文件夹 / 上传表单（同一位置交替出现） */}
      {mkdirOpen && (
        <MkdirForm
          value={mkdirName}
          busy={busy}
          onChange={setMkdirName}
          onSubmit={() => void doMkdir()}
          onCancel={() => setMkdirOpen(false)}
        />
      )}
      {uploadOpen && (
        <UploadForm
          value={uploadLocal}
          busy={busy}
          mac={mac}
          onChange={setUploadLocal}
          onPick={() => void pickUpload()}
          onSubmit={() => void doUpload()}
          onCancel={() => setUploadOpen(false)}
        />
      )}

      {/* 传输中：进度 + 取消。一次只会有一条。 */}
      {xfer.transfer && (
        <TransferBar transfer={xfer.transfer} onCancel={xfer.cancel} />
      )}

      {/* 文件列表 */}
      <FileTable
        entries={entries}
        loading={loading}
        error={error}
        busy={busy}
        onOpenDir={openDir}
        onDownload={handleDownload}
        onRemove={setRemoveTarget}
      />

      {/* 下载目标表单 */}
      {downloadFor && (
        <DownloadForm
          name={downloadFor}
          value={downloadLocal}
          busy={busy}
          mac={mac}
          onChange={setDownloadLocal}
          onSubmit={() => void doDownload(downloadFor)}
          onCancel={() => setDownloadFor(null)}
        />
      )}

      {/* 删除二次确认（项目内 Dialog，统一 Tauri 风格） */}
      <RemoveConfirmDialog
        target={removeTarget}
        busy={busy}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />

      {/* 覆盖确认：删除有二次确认，覆盖也必须有——两者丢数据的后果一样。 */}
      <OverwriteConfirmDialog
        prompt={xfer.prompt}
        onCancel={xfer.dismissPrompt}
      />
    </div>
  );
}
