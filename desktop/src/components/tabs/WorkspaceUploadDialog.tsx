import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import type { useWorkspaceUpload } from "./useWorkspaceUpload";
import type { useSshFileForms } from "./useSshFileForms";

export function WorkspaceDownloadDialog({ plan, close }: {
  plan: ReturnType<typeof useSshFileForms>["folderDownload"];
  close: () => void;
}) {
  if (!plan) return null;
  return <Dialog open ariaLabel="下载目录" onClose={close}>
    <DialogHeader><DialogTitle>下载目录</DialogTitle></DialogHeader>
    <p className="text-sm break-all">{plan.folders.map(row => row.name).join("、")}</p>
    <p className="mt-2 break-all rounded-md bg-muted p-2 text-xs">本机目标 {plan.dir}</p>
    <p className="mt-2 text-xs text-muted-foreground">保留子目录和空目录，跳过符号链接。需要更名的项目可以在传输任务中处理。</p>
    <div className="mt-4 flex justify-end gap-2">
      <Button variant="outline" onClick={close}>取消</Button>
      <Button onClick={() => { close(); void plan.enqueue(); }}>加入传输</Button>
    </div>
  </Dialog>;
}

export function WorkspaceUploadDialog({ upload }: { upload: ReturnType<typeof useWorkspaceUpload> }) {
  const { plan, busy, invalid } = upload;
  if (!plan) return null;
  return <Dialog open ariaLabel="上传文件夹" onClose={upload.dismiss}>
    <DialogHeader><DialogTitle>上传文件夹</DialogTitle></DialogHeader>
    <p className="break-all rounded-md bg-muted p-2 text-xs">远端目标 {plan.target.path}</p>
    <div className="max-h-[38vh] overflow-auto">
      {plan.folders.map((folder, i) => <label key={folder.local} className="mt-3 block text-sm">
        <span className="block truncate" title={folder.local}>{folder.local}</span>
        <Input aria-label={`远端文件夹名称 ${i + 1}`} className="mt-1" disabled={busy} value={folder.name}
          onChange={event => upload.rename(i, event.target.value)}/>
      </label>)}
    </div>
    {plan.files.length > 0 && <p className="mt-2 text-xs">同时上传 {plan.files.length} 个单独选择的文件。</p>}
    <p className="mt-2 text-xs text-muted-foreground">保留子目录结构和空目录，跳过符号链接。</p>
    {invalid && <p role="alert" className="mt-1 text-xs text-destructive-ink">请输入有效且不重复的文件夹名称。</p>}
    <div className="mt-4 flex justify-end gap-2">
      <Button variant="outline" disabled={busy} onClick={upload.dismiss}>取消</Button>
      <Button isLoading={busy} disabled={invalid} loadingText="正在整理…" onClick={() => void upload.submit()}>加入传输</Button>
    </div>
  </Dialog>;
}
