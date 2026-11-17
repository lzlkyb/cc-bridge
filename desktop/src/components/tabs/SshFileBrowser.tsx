import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { isMac } from "../../lib/platform";
import type { SshConnection } from "../../lib/types";
import { FileTable } from "./SshFileRow";
import { FileBatchBar } from "./FileBatchBar";
import { useSshFileSelection } from "./useSshFileSelection";
import { MkdirForm, UploadForm } from "./SshFileForms";
import { SshDownloadStatus } from "./SshDownloadStatus";
import { FileHeader, RemoveConfirmDialog } from "./SshFileToolbar";
import { useSshTransfer } from "./useSshTransfer";
import { OverwriteConfirmDialog, TransferBarSlot } from "./SshTransferBar";
import { SshDropOverlay } from "./SshDropOverlay";
import { useFileBrowserDrop } from "./useFileBrowserDrop";
import { useSshFileForms } from "./useSshFileForms";
import { useSshFileInitialPath } from "../../hooks/useSshFileInitialPath";
import { loadUploadDir, saveUploadDir } from "../../lib/uploadDir";
import { useSshFileListing } from "../../hooks/useSshFileListing";
import { isInitialFileListing } from "../../lib/sshFilePaths";
import { useRemoteNavigation } from "../../hooks/useRemoteNavigation";
import { SshFileEditor } from "./SshFileEditor";
import { useSshFileOps } from "./useSshFileOps";

interface Props {
  conn: SshConnection;
  onBack: () => void;
  /**
   * 初始定位路径（终端路径点击入口传入）。**可能是文件**：列目录失败时回退到其
   * 父目录再列一次（文件浏览器只管目录）。undefined = 用「上次上传目录」。
   */
  initialPath?: string;
  /** 该连接当前已断开：文件操作会失败，给一条带「重新连接」出路的提示。 */
  disconnected?: boolean;
  onReconnect?: () => void;
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
export function SshFileBrowser({ conn, onBack, initialPath, disconnected, onReconnect }: Props) {
  // 起始路径用「上次上传目录」而不是写死的 `/`：面板一关就 unmount，
  // 每次重开都从根目录开始本来就难用；而且这份状态与终端拖拽共用，
  // 两个入口才不会各自漂移。终端路径点击进来则优先用它指定的路径。
  const navigation = useRemoteNavigation(initialPath ?? loadUploadDir(conn.id));
  const { path, navigate: setPath } = navigation;
  const { entries, loading, error, refresh } = useSshFileListing(conn.id, path);
  // mkdir / 删除这类瞬时操作（含 busy 与删除确认态）自成一套生命周期，拆去
  // useSshFileOps：本组件只留导航 / 传输 / 编辑器开关。
  const ops = useSshFileOps({
    connectionId: conn.id,
    path,
    joinRemote,
    onDone: () => void refresh(),
    // `sel` 在本行之后才声明，用 ref 转发，避免把 hook 调用顺序拧成环。
    onRemoved: () => clearSelectionRef.current(),
  });
  // 正在编辑的文件（双击打开，覆盖在列表之上）。WinSCP / MobaXterm 的共性：
  // 双击即编辑，而不是「另存为」。关掉编辑器后列表原地刷新（大小/时间已变）。
  const [editing, setEditing] = useState<string | null>(null);
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
  // 传输进行中也算忙：避免并发多条 ssh 握手（本机不支持连接复用，成本乘以 N）。
  // 含 `xfer.prompt`：否则确认框开着还能接第二批拖放，第二次 setPrompt 会覆盖第一次，
  // 第一批的 Promise 永远不 resolve。
  const operationBusy = ops.busy || !!xfer.transfer || !!xfer.prompt || forms.download.busy;
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

  // 超过 SLOW_HINT_MS 还在加载就补一句解释。WHY：本机 OpenSSH 不支持连接复用
  // （无 ControlMaster），每次列目录都是一次完整的 TCP + 认证握手，慢链路上好几秒
  // 很正常；只转圈不说话，用户无法区分「慢」和「死」。
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
  // 双击文件：打开内联编辑器。下载仍然是行尾按钮与多选批量条的事——
  // 「查看/编辑」是高频，「下载到本机」是低频，双击应该给前者。
  const openEditor = (name: string) => { if (!busy) setEditing(joinRemote(path, name)); };

  // 多选（Ctrl/⌘+点击、Shift+区间）。clear 是 useCallback([]) 稳定引用，解构出来
  // 才能正常写依赖：sel 整体每帧都是新对象，写进依赖等于每次渲染都清一遍选择。
  const sel = useSshFileSelection({
    entries,
    onDownload: forms.handleDownload,
    onDownloadMany: forms.handleDownloadMany,
    busy,
  });
  const { clear: clearSelection } = sel;
  // 删除成功后要清多选；`sel` 在 ops 之后才建，用 ref 转发（见 ops 的 onRemoved）。
  const clearSelectionRef = useRef<() => void>(() => {});
  clearSelectionRef.current = clearSelection;
  // 换目录后选择失效：名字只在当前目录有意义。
  useEffect(() => { clearSelection(); }, [path, clearSelection]);

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
        onNewFolder={ops.toggleMkdir}
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

      {/* 断线提示：面板是覆盖层，用户看不到下面终端里的黄色横幅与「重新连接」，
          以前只能一路点到返回再去找终端。 */}
      {disconnected && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          <span className="min-w-0 flex-1">这条连接已断开，列表是断开前的快照，文件操作会失败。</span>
          {onReconnect && (
            <button
              type="button"
              onClick={onReconnect}
              className="shrink-0 rounded-md bg-amber-500/20 px-2 py-1 font-medium hover:bg-amber-500/30"
            >
              重新连接
            </button>
          )}
        </div>
      )}

      {/* 新建文件夹 / 上传表单（同一位置交替出现） */}
      {ops.mkdirOpen && (
        <MkdirForm
          value={ops.mkdirName}
          busy={busy}
          onChange={ops.setMkdirName}
          onSubmit={() => void ops.doMkdir()}
          onCancel={() => ops.toggleMkdir()}
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

      {/* 多选批量操作条：选了才出现 */}
      {sel.selected.length > 0 && (
        <FileBatchBar
          total={sel.selected.length}
          files={sel.fileCount}
          busy={busy}
          onDownload={sel.downloadSelected}
          onRemove={() =>
            sel.removeSelected(list =>
              ops.setTargets(list.map((e) => ({ ...e, remotePath: joinRemote(path, e.name) }))),
            )
          }
          onSelectAll={sel.selectAll}
          onClear={sel.clear}
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
        selectedNames={sel.selected}
        onOpenDir={openDir}
        onDownload={forms.handleDownload}
        onRemove={entry => ops.setTargets([{ ...entry, remotePath: joinRemote(path, entry.name) }])}
        onSelect={sel.pick}
        onActivateFile={openEditor}
        onRetry={() => void refresh()}
      />

      {/* 编辑器覆盖层：关掉时刷新列表，让刚保存的大小/时间立刻可见 */}
      {editing && (
        <SshFileEditor
          key={editing}
          conn={conn}
          path={editing}
          onBack={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}

      <TransferBarSlot transfer={xfer.transfer} onCancel={xfer.cancel} />
      {!xfer.transfer && !xfer.prompt && <SshDownloadStatus download={forms.download} busy={busy} />}

      {/* 删除二次确认（项目内 Dialog，统一 Tauri 风格）；多选批量时一次问完 */}
      <RemoveConfirmDialog
        targets={ops.targets}
        busy={busy}
        onConfirm={() => void ops.confirmRemove()}
        onCancel={() => ops.setTargets([])}
      />

      {/* 覆盖确认：删除有二次确认，覆盖也必须有——两者丢数据的后果一样。 */}
      <OverwriteConfirmDialog
        prompt={xfer.prompt}
        onCancel={xfer.dismissPrompt}
      />
    </div>
  );
}
