import { useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { invoke } from "../../lib/tauri";
import { cleanErr } from "../../lib/utils";
import type { RemoteFileContent } from "../../hooks/useRemoteFileEdit";

// Drafts contain remote file content. Keep them in memory for the current app window.
const drafts = new Map<string, string>();

export function SshFileConflictReview({ connectionId, path, content, conflict, canRestore, onRestore }: {
  connectionId: string; path: string; content: string; conflict: boolean; canRestore: boolean; onRestore: (content: string) => void;
}) {
  const key = `${connectionId}\0${path}`;
  const [saved, setSaved] = useState(() => drafts.get(key));
  const [review, setReview] = useState<{ loading?: boolean; text?: string; error?: string; truncated?: boolean } | null>(null);
  const open = async () => {
    setReview({ loading: true });
    try {
      const result = await invoke<RemoteFileContent>("ssh_file_read", { connectionId, path });
      setReview(current => current?.loading ? { text: result.content, truncated: result.truncated } : current);
    } catch (error) { setReview(current => current?.loading ? { error: cleanErr(error) } : current); }
  };
  const keep = () => {
    if (drafts.size >= 12 && !drafts.has(key)) drafts.delete(drafts.keys().next().value!);
    drafts.set(key, content); setSaved(content); setReview(null);
  };
  if (!conflict && saved === undefined) return null;
  return <>
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
      {conflict && <><Button variant="outline" size="sm" className="h-6 px-2" onClick={() => void open()}>对照服务器版本</Button><Button variant="outline" size="sm" className="h-6 px-2" onClick={keep}>保留我的草稿</Button></>}
      {saved !== undefined && <><span className="text-muted-foreground">草稿已保留在当前窗口</span>{canRestore && saved !== content && <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => onRestore(saved)}>恢复草稿</Button>}<Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => { drafts.delete(key); setSaved(undefined); }}>丢弃草稿</Button></>}
    </div>
    <Dialog open={!!review} ariaLabel="编辑冲突" onClose={() => setReview(null)}>
      <DialogHeader><DialogTitle>编辑冲突</DialogTitle></DialogHeader>
      <p className="break-all text-xs text-muted-foreground">{path}</p>
      {review?.loading && <p role="status" className="mt-2 text-sm">正在读取服务器版本…</p>}
      {review?.error && <p role="alert" className="mt-2 text-sm text-destructive-ink">读取失败：{review.error}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><section><h4 className="mb-1 font-medium">服务器当前版本{review?.truncated ? "（预览）" : ""}</h4><pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-2">{review?.text}</pre></section>
        <section><h4 className="mb-1 font-medium">我的修改</h4><pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-2">{content}</pre></section></div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setReview(null)}>关闭</Button><Button onClick={keep}>保留我的草稿</Button></div>
    </Dialog>
  </>;
}
