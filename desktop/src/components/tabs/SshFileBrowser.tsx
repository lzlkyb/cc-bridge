import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { isMac } from "../../lib/platform";
import { toast } from "../ui/toast";
import type { SshConnection, SshFileEntry } from "../../lib/types";
import { FileTable } from "./SshFileRow";
import { MkdirForm, UploadForm } from "./SshFileForms";
import { SshDownloadStatus } from "./SshDownloadStatus";
import { FileHeader, RemoveConfirmDialog } from "./SshFileToolbar";
import { useSshTransfer } from "./useSshTransfer";
import { cleanErr } from "../../lib/utils";
import { OverwriteConfirmDialog, TransferBarSlot } from "./SshTransferBar";
import { SshDropOverlay } from "./SshDropOverlay";
import { useFileBrowserDrop } from "./useFileBrowserDrop";
import { useSshFileForms } from "./useSshFileForms";
import { useSshFileInitialPath } from "../../hooks/useSshFileInitialPath";
import { loadUploadDir, saveUploadDir } from "../../lib/uploadDir";
import { useSshFileListing } from "../../hooks/useSshFileListing";
import { isInitialFileListing } from "../../lib/sshFilePaths";
import { useRemoteNavigation } from "../../hooks/useRemoteNavigation";

interface Props {
  conn: SshConnection;
  onBack: () => void;
  /**
   * 初始定位路径（终端路径点击入口传入）。**可能是文件**：列目录失败时回退到其
   * 父目录再列一次（文件浏览器只管目录）。undefined = 用「上次上传目录」。
   */
  initialPath?: string;
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
 * 下载通过系统另存为选择位置，传输状态与结果留在文件列表底部。
 */
export function SshFileBrowser({ conn, onBack, initialPath }: Props) {
  // 起始路径用「上次上传目录」而不是写死的 `/`：面板一关就 unmount，
  // 每次重开都从根目录开始本来就难用；而且这份状态与终端拖拽共用，
  // 两个入口才不会各自漂移。终端路径点击进来则优先用它指定的路径。
  const navigation = useRemoteNavigation(initialPath ?? loadUploadDir(conn.id));
  const { path, navigate: setPath } = navigation;
  const { entries, loading, error, refresh } = useSshFileListing(conn.id, path);
  // 传输态交给 useSshTransfer 管，这里只管 mkdir / 删除这类瞬时操作。
  const [busyOp, setBusyOp] = useState(false);
  // 新建文件夹名。
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  // 删除确认：待删除条目（项目内 Dialog 二次确认，避免 window.confirm 与 Tauri 风格割裂）。
  const [removeTarget, setRemoveTarget] = useState<(SshFileEntry & { remotePath: string }) | null>(null);
  // 列目录超过这个时长还没回来，就在界面上解释一下（而不是让圈一直转）。
  const SLOW_HINT_MS = 2500;

  // 平台标识用于切换占位文案（mac 显示 POSIX 路径，Windows 显示盘符路径）。
  // get_status 是全局缓存的查询，这里复用不会多开连接。
  const { data: status } = useQuery({
    queryKey: ["get_status"],
    queryFn: () => invoke<{ platform?: string }>("get_status"),
  });
  const mac = isMac(status?.platform);
  const xfer = useSshTransfer();
  const forms = useSshFileForms({connectionId:conn.id, path, entries, xfer, joinRemote, onUploaded:() => void refresh()});
  // 传输进行中也算忙：期间禁掉新建/上传/删除，避免并发多条 ssh 握手
  // （本机 OpenSSH 不支持连接复用，并发只会把握手成本乘以 N）。
  // 含 `xfer.prompt`（覆盖确认框）：否则确认框开着时还能接第二批拖放，
  // 第二次 setPrompt 会覆盖第一次，第一批的 Promise 永远不 resolve。
  const operationBusy = busyOp || !!xfer.transfer || !!xfer.prompt || forms.download.busy;
  const busy = operationBusy || loading || !!error;
  const highlightName = useSshFileInitialPath(initialPath, error, path, navigation.replace, entries);

  // 当前目录回写成「上次上传目录」：下次重开面板与终端拖拽都从这里起。
  useEffect(() => {
    if (!loading && !error && !isInitialFileListing(path, entries)) saveUploadDir(conn.id, path);
  }, [conn.id, path, entries, loading, error]);

  const { paneRef, ...drop } = useFileBrowserDrop({
    connectionId: conn.id,
    path,
    entries,
    busy,
    uploadMany: xfer.uploadMany,
    onDone: () => void refresh(),
  });

  // 超过 SLOW_HINT_MS 还在加载就补一句解释。
  //
  // WHY：本机 OpenSSH 不支持连接复用（无 ControlMaster），**每次列目录都是一次完整的
  // TCP + 认证握手**，慢链路上好几秒很正常，超时上限是 30 秒。只转个圈不说话的话，
  // 用户无法区分「慢」和「死」，只能干等。
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => clearTimeout(t);
  }, [loading]);

  const openDir = (name: string) => { if (!busy) setPath(joinRemote(path, name)); };

  const doMkdir = async () => {
    if (busy || !mkdirName.trim()) return;
    setBusyOp(true);
    try {
      await invoke("ssh_sftp_mkdir", {
        connectionId: conn.id,
        path: joinRemote(path, mkdirName.trim()),
      });
      toast("已创建文件夹", "success");
      setMkdirOpen(false);
      setMkdirName("");
      void refresh();
    } catch (e) {
      toast(`创建失败：${cleanErr(e)}`, "error");
    } finally {
      setBusyOp(false);
    }
  };

  const confirmRemove = async () => {
    const e = removeTarget;
    if (!e || busy) return;
    setRemoveTarget(null);
    setBusyOp(true);
    try {
      await invoke("ssh_sftp_remove", {
        connectionId: conn.id,
        path: e.remotePath,
      });
      toast(`已删除：${e.name}`, "success");
      void refresh();
    } catch (err) {
      toast(`删除失败：${cleanErr(err)}`, "error");
    } finally {
      setBusyOp(false);
    }
  };

  return (
    <div ref={paneRef} className="relative flex h-full min-h-0 flex-col">
      {drop.zone === "files" && <SshDropOverlay count={drop.count} dir={path} />}
      {/* 顶部：返回 + 连接信息 + 操作 + 路径条 */}
      <FileHeader
        conn={conn}
        path={path}
        loading={loading}
        busy={operationBusy}
        directoryReady={!error}
        onBack={onBack}
        onUp={() => setPath(parentRemote(path))}
        onNavigate={target => { if (!operationBusy && !loading) setPath(target); }}
        canBack={navigation.canBack} canForward={navigation.canForward}
        onHistoryBack={navigation.back} onHistoryForward={navigation.forward}
        onRefresh={() => void refresh()}
        onNewFolder={() => {
          setMkdirOpen((v) => !v);
          setMkdirName("");
        }}
        onUpload={() => {
          forms.setUploadOpen((v) => !v);
          forms.setUploadLocal("");
        }}
      />
      {loading && slow && (
        <div className="shrink-0 border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          正在读取远程目录…首次需要建立一条常驻会话，后续操作会快很多；若服务器不支持常驻会话会自动退回旧方式，最长可能等一分钟。
        </div>
      )}

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
      {forms.uploadOpen && (
        <UploadForm
          value={forms.uploadLocal}
          busy={busy}
          mac={mac}
          onChange={forms.setUploadLocal}
          onPick={() => void forms.pickUpload()}
          onSubmit={() => void forms.doUpload()}
          onCancel={() => forms.setUploadOpen(false)}
        />
      )}

      {/* 文件列表。key={path}：换目录重挂 → FileTable 根的 animate-fade-in 播整列淡入；
          同时顺带把滚动位置归位（新目录从顶部看起是正确语义）。 */}
      <FileTable
        key={path}
        entries={entries}
        loading={loading}
        error={error}
        busy={busy}
        highlightName={highlightName}
        onOpenDir={openDir}
        onDownload={forms.handleDownload}
        onRemove={entry => setRemoveTarget({ ...entry, remotePath: joinRemote(path, entry.name) })}
        onRetry={() => void refresh()}
      />

      <TransferBarSlot transfer={xfer.transfer} onCancel={xfer.cancel} />
      {!xfer.transfer && !xfer.prompt && <SshDownloadStatus download={forms.download} busy={busy} />}

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
