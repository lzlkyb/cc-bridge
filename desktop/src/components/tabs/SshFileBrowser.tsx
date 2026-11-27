import { useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { isMac } from "../../lib/platform";
import type { SshConnection } from "../../lib/types";
import { FileTable } from "./SshFileRow";
import { FileBatchBar } from "./FileBatchBar";
import { useSshFileSelection } from "./useSshFileSelection";
import { MkdirForm, UploadForm } from "./SshFileForms";
import { WorkspaceDownloadDialog, WorkspaceUploadDialog } from "./WorkspaceUploadDialog";
import { SshTransferPanel } from "./SshTransferQueueButton";
import { FileHeader, RemoveConfirmDialog } from "./SshFileToolbar";
import { useSshTransfer } from "./useSshTransfer";
import { OverwriteConfirmDialog } from "./SshTransferBar";
import { SshDropOverlay } from "./SshDropOverlay";
import { useFileBrowserDrop } from "./useFileBrowserDrop";
import { useSshFileForms } from "./useSshFileForms";
import { useSshFileInitialPath } from "../../hooks/useSshFileInitialPath";
import { loadUploadDir, saveUploadDir } from "../../lib/uploadDir";
import { useSshFileListing } from "../../hooks/useSshFileListing";
import { useSshFileViewer } from "../../hooks/useSshFileViewer";
import { isInitialFileListing } from "../../lib/sshFilePaths";
import { useRemoteNavigation } from "../../hooks/useRemoteNavigation";
import { SshFileEditor } from "./SshFileEditor";
import { useSshFileOps } from "./useSshFileOps";
import { useSshFileView } from "../../hooks/useSshFileView";
import { useSshFileRename } from "./useSshFileRename";
import { SshFileNotices } from "./SshFileNotices";
import { RenameDialog, MoveDialog, RenameOverwriteDialog } from "./SshFileRenameDialogs";
import { TerminalFileWorkspace, useFileWorkspaceLocation } from "./useTerminalFileWorkspace";
import { SshFileWorkspaceTools } from "./SshFileWorkspaceTools";

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
 * SFTP 文件管理器：列目录 / 进入 / 上一级 / 下载 / 上传 / 新建 / 删除 /
 * 重命名 / 移动，外加表头排序与常驻过滤（读取侧派生，见 useSshFileView）。
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
  useFileWorkspaceLocation(conn.id, path, setPath, refresh, !loading && !error && !isInitialFileListing(path, entries));
  // 远端身份（uid/gid/组）：只拉一次，供列表预标「你不可读」；失败静默不预标。
  const viewer = useSshFileViewer(conn.id);
  // 排序 / 过滤在读取侧派生：快照必须是服务器原始序（useSshFileView 的 WHY）。
  // 选择 hook 也收 view.items——shift 区间锚点与用户看到的行序一致。
  const view = useSshFileView(entries, path);
  // 删除 / 重命名 / 移动成功后要清多选；`sel` 在这些 hook 之后才建，用 ref
  // 转发，避免把 hook 调用顺序拧成环（见 ops 的 onRemoved）。
  const clearSelectionRef = useRef<() => void>(() => {});
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
  // 重命名 / 移动（批次③）：与 ops 同一模式——一个 busy、成功后刷新。
  // 差异在覆盖语义：第一次 overwrite=false，后端 TARGET_EXISTS 预检命中才弹
  // 确认（useSshFileRename），没有静默覆盖路径。
  const rename = useSshFileRename({
    connectionId: conn.id,
    path,
    joinRemote,
    onDone: () => void refresh(),
    // 旧名字不会自己从 selected 里掉：成功后请调用方清多选（同样 ref 转发）。
    onChanged: () => clearSelectionRef.current(),
  });
  // 正在编辑的文件（双击打开，覆盖在列表之上）。WinSCP / MobaXterm 的共性：
  // 双击即编辑，而不是「另存为」。关掉编辑器后列表原地刷新（大小/时间已变）。
  const [located, setLocated] = useState<{ directory: string; name?: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  // 平台标识用于切换占位文案（mac 显示 POSIX 路径，Windows 显示盘符路径）。
  // get_status 是全局缓存的查询，这里复用不会多开连接。
  const { data: status } = useQuery({
    queryKey: ["get_status"],
    queryFn: () => invoke<{ platform?: string }>("get_status"),
  });
  const mac = isMac(status?.platform);
  const workspace = useContext(TerminalFileWorkspace);
  const dual = workspace?.mode === "local";
  const xfer = useSshTransfer();
  const forms = useSshFileForms({ connectionId:conn.id, path, entries, xfer, dual, localPath: workspace?.localPath,
    windows: !mac, onEnqueue: () => clearSelectionRef.current() });
  // 后台传输期间仍可浏览，确认同名时锁定目录以保留当前目标。
  const navigationBusy = ops.busy || rename.busy || !!xfer.prompt || !!forms.upload?.plan || !!disconnected;
  const operationBusy = navigationBusy || !!forms.upload?.busy || forms.download.busy || forms.preparingDownload || !!xfer.transfer;
  const busy = operationBusy || loading || !!error;
  const highlightName = useSshFileInitialPath(initialPath, error, path, navigation.replace, entries);

  // 当前目录回写成「上次上传目录」：下次重开面板与终端拖拽都从这里起。
  useEffect(() => {
    if (!loading && !error && !isInitialFileListing(path, entries)) saveUploadDir(conn.id, path);
  }, [conn.id, path, entries, loading, error]);

  const { paneRef, ...drop } = useFileBrowserDrop({ busy, uploadPaths: forms.uploadPaths });

  const openDir = (name: string) => { if (!navigationBusy && !loading && !error) setPath(joinRemote(path, name)); };
  // 双击文件：打开内联编辑器。下载仍然是行尾按钮与多选批量条的事——
  // 「查看/编辑」是高频，「下载到本机」是低频，双击应该给前者。
  const openEditor = (name: string) => { if (!busy) setEditing(joinRemote(path, name)); };

  // 区间选择按可见行排序；依赖稳定的 clear，避免每次渲染清空选择。
  const sel = useSshFileSelection({
    includeDirectories: true,
    entries: view.items,
    onDownload: forms.handleDownload,
    onDownloadMany: forms.handleDownloadMany,
    busy,
  });
  const { clear: clearSelection } = sel;
  // 删除 / 重命名 / 移动成功后清多选（ref 在 ops/rename 之前已声明）。
  clearSelectionRef.current = clearSelection;
  // 换目录后选择失效：名字只在当前目录有意义。
  useEffect(() => { clearSelection(); }, [path, clearSelection]);

  return (
    <div ref={paneRef} className="relative flex h-full min-h-0 flex-col">
      {drop.zone === "files" && <SshDropOverlay count={drop.count} dir={path} />}
      <FileHeader
        conn={conn}
        path={path}
        loading={loading}
        busy={operationBusy}
        navigationBusy={navigationBusy}
        disconnected={disconnected}
        moreActions={<SshFileWorkspaceTools key={conn.id} connectionId={conn.id} path={path} disabled={loading || !!error || disconnected} navigate={setPath} preview={setEditing}/>}
        directoryReady={!error}
        onBack={onBack}
        onUp={() => setPath(parentRemote(path))}
        onNavigate={target => { if (!navigationBusy && !loading) setPath(target); }}
        canBack={navigation.canBack} canForward={navigation.canForward}
        onHistoryBack={navigation.back} onHistoryForward={navigation.forward}
        onRefresh={() => void refresh()}
        onNewFolder={ops.toggleMkdir}
        onUpload={() => void forms.pickUpload()}
        onUploadFolder={() => void forms.pickFolder()}
        onUploadPath={() => { forms.setUploadOpen(true); forms.setUploadLocal(""); }}
        query={view.query}
        onQueryChange={view.setQuery}
      />
      {/* 慢加载解释 + 断线横幅（下沉 SshFileNotices：各自带计时器状态） */}
      <SshFileNotices loading={loading} disconnected={disconnected} onReconnect={onReconnect} />

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
          onSubmit={() => void forms.doUpload()}
          onCancel={() => forms.setUploadOpen(false)}
        />
      )}

      {/* 多选批量操作条：常驻。条件挂载会让列表整体上下位移一行，第一次点文件
          时正在看的行会跳走——常驻后三种状态下批量条高度恒定，首行位置不变。
          total 用 view 口径（过滤后条目数/已选数）：计数与按钮实际作用对象一致，
          不会出现「已选 3 个」却只作用 1 个。 */}
      <FileBatchBar
        total={view.items.length}
        selected={sel.chosen.length}
        hasSelection={sel.selected.length > 0}
        files={sel.fileCount}
        downloadable={sel.chosen.filter(entry => !entry.isSymlink).length}
        downloadTarget={dual ? workspace.localPath : undefined}
        downloadLabel={dual ? (workspace.localPath ? "下载到本机" : "选择下载目录…") : "下载所选"}
        busy={busy}
        onDownload={sel.downloadSelected}
        onRemove={() =>
          sel.removeSelected(list =>
            ops.setTargets(list.map((e) => ({ ...e, remotePath: joinRemote(path, e.name) }))),
          )
        }
        onMove={() => rename.openMove(sel.chosen)}
        onSelectAll={sel.selectAll}
        onClear={sel.clear}
      />

      {/* A new directory starts at the top, with its cached rows visible immediately. */}
      <FileTable
        key={path}
        entries={view.items}
        loading={loading}
        error={error}
        busy={busy}
        navigationBusy={navigationBusy || !!error}
        filterActive={!!view.query.trim() && view.items.length === 0}
        highlightName={located?.directory === path ? located.name : highlightName}
        selectedNames={sel.selected}
        onOpenDir={openDir}
        onDownload={forms.handleDownload}
        onDownloadAs={forms.downloadAs}
        onRemove={entry => ops.setTargets([{ ...entry, remotePath: joinRemote(path, entry.name) }])}
        onRename={rename.openRename}
        onMove={entry => rename.openMove([entry])}
        onSelect={sel.pick}
        onActivateFile={openEditor}
        onRetry={() => void refresh()}
        sort={view.sort}
        onToggleSort={view.toggleSort}
        viewer={viewer}
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

      <SshTransferPanel connectionId={conn.id} onLocateRemote={target => {
        setPath(target.directory);
        setLocated(target);
        if (target.directory === path) void refresh();
      }}/>
      {forms.upload && <WorkspaceUploadDialog upload={forms.upload}/>}
      {forms.folderDownload && <WorkspaceDownloadDialog plan={forms.folderDownload} close={forms.dismissFolderDownload}/>}

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

      {/* 重命名 / 移动 / 覆盖确认（批次③；三个对话框不会同时开） */}
      {rename.renameEntry && (
        <RenameDialog entry={rename.renameEntry} value={rename.renameName} busy={busy}
          onChange={rename.setRenameName} onSubmit={() => void rename.submitRename()} onCancel={rename.closeRename} />
      )}
      {rename.moveEntries && (
        <MoveDialog entries={rename.moveEntries} dir={rename.moveDir} busy={busy}
          onChange={rename.setMoveDir} onSubmit={() => void rename.submitMove()} onCancel={rename.closeMove} />
      )}
      {rename.overwrite && (
        <RenameOverwriteDialog prompt={rename.overwrite} busy={busy} onCancel={rename.cancelOverwrite}
          onOverwrite={() => void rename.confirmOverwrite()}
          onSkip={rename.overwrite.onSkip ? () => void rename.skipConflicts() : undefined} />
      )}
    </div>
  );
}
