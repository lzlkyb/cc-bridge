import { useCallback, useEffect, useMemo, useState } from "react";
import type { SshConnection } from "../../lib/types";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { cleanErr } from "../../lib/utils";
import { useThemeMode } from "../../hooks/useThemeMode";
import { useRemoteFileEdit } from "../../hooks/useRemoteFileEdit";
import { baseName, languageFor } from "../../lib/remoteFileLang";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { SshFileEditorBar } from "./SshFileEditorBar";
import { SshFileEditorNotice } from "./SshFileEditorNotice";
import { SshFileEditorStatus } from "./SshFileEditorStatus";

interface Props {
  conn: SshConnection;
  /** 远程文件完整路径。 */
  path: string;
  onBack: () => void;
}

/** 骨架行数（首次读取时的占位）。 */
const SKELETON_ROWS = 16;

/**
 * 远程文件编辑器（A+C 方案的前端）。
 *
 * 双击文件列表里的一条即打开：读走常驻 helper 会话（列目录已建好的那条），
 * 保存走「临时文件 + rename」原子替换。超过 2 MB 只读预览，非 UTF-8 直接
 * 引导「用本机编辑器打开」（C 路线：scp 下到本机临时副本，编辑完回传）。
 *
 * 冲突不弹窗（R17）：后端在保存时用 mtime 乐观锁拒绝，这里渲染内联条给
 * 「重新加载 / 仍然覆盖保存」。
 */
export function SshFileEditor({ conn, path, onBack }: Props) {
  const theme = useThemeMode();
  const fileName = useMemo(() => baseName(path), [path]);
  const extensions = useMemo(() => languageFor(path), [path]);
  // C 路线：已用本机编辑器打开时的临时副本信息（回传用）。
  const [external, setExternal] = useState<{ localPath: string; mtime: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const edit = useRemoteFileEdit({
    connectionId: conn.id,
    path,
    onExternalOpened: setExternal,
  });

  const busy = edit.phase !== "ready";
  const canSave = !edit.readOnly && edit.phase === "ready";

  const save = useCallback(
    (force: boolean) => {
      if (!canSave) return;
      void edit.save(force);
    },
    [canSave, edit],
  );

  // Ctrl+S / ⌘S：编辑器聚焦时由 CodeMirror 的 keymap 处理，这里兜住
  // 「焦点在别处（刚点过工具栏）」的情况，两个入口行为一致。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const uploadEdited = useCallback(async () => {
    if (!external) return;
    setUploading(true);
    try {
      await invoke("ssh_file_upload_edited", {
        connectionId: conn.id,
        path,
        localPath: external.localPath,
        expectedMtime: external.mtime,
        force: false,
      });
      toast("已回传到服务器", "success");
      setExternal(null);
      await edit.load();
    } catch (e) {
      const msg = cleanErr(e);
      // 与内联保存同一语义；用 includes——错误被包成 Error 对象时前缀会多 "Error: "
      if (msg.includes("CCB_FILE_CONFLICT")) {
        toast("服务器上的文件已被改过，请重新打开再回传", "error");
      } else {
        toast(`回传失败：${msg}`, "error");
      }
    } finally {
      setUploading(false);
    }
  }, [conn.id, path, external, edit]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-card">
      <SshFileEditorBar
        path={path}
        fileName={fileName}
        dirty={edit.dirty}
        busy={busy || uploading}
        canSave={canSave}
        onBack={onBack}
        onSave={() => save(false)}
        onOpenExternal={() => void edit.openExternal()}
      />

      {/* C 路线回传条：本机编辑器还开着时提醒用户改完要点回传 */}
      {external && (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary"
        >
          <span className="min-w-0 flex-1">
            已用本机编辑器打开，编辑保存后点「回传」写回服务器。
          </span>
          <button
            type="button"
            disabled={uploading}
            onClick={() => void uploadEdited()}
            className="shrink-0 rounded-md bg-primary/20 px-2 py-1 font-medium hover:bg-primary/30 disabled:opacity-50"
          >
            {uploading ? "回传中…" : "回传"}
          </button>
          <button
            type="button"
            onClick={() => setExternal(null)}
            className="shrink-0 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            关闭
          </button>
        </div>
      )}

      <SshFileEditorNotice
        conflict={edit.conflict}
        remoteMtime={edit.meta?.mtime ?? 0}
        truncated={edit.readOnly}
        size={edit.meta?.size ?? 0}
        error={edit.error}
        errorKind={edit.errorKind ?? "read"}
        busy={busy || uploading}
        onReload={() => void edit.reload()}
        onForceSave={() => save(true)}
        onOpenExternal={() => void edit.openExternal()}
      />

      {edit.phase === "loading" && !edit.content ? (
        <div className="min-h-0 flex-1 animate-pulse space-y-2 overflow-hidden p-4" aria-busy="true">
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div
              key={i}
              className="h-3 rounded bg-muted"
              style={{ width: `${35 + ((i * 37) % 55)}%` }}
            />
          ))}
        </div>
      ) : (
        <CodeMirrorHost
          className="min-h-0 flex-1 overflow-hidden"
          value={edit.content}
          onChange={edit.onChange}
          readOnly={edit.readOnly || edit.phase !== "ready"}
          extensions={extensions}
          theme={theme}
          onSave={() => save(false)}
        />
      )}

      <SshFileEditorStatus
        encoding={edit.meta?.encoding ?? "utf-8"}
        lineEnding={edit.meta?.lineEnding ?? "lf"}
        lineCount={edit.content ? edit.content.split("\n").length : 0}
        size={edit.meta?.size ?? 0}
        dirty={edit.dirty}
        conflict={edit.conflict}
        readOnly={edit.readOnly}
        remoteMtime={edit.meta?.mtime ?? 0}
        endpoint={`${conn.username}@${conn.host}`}
        loading={edit.phase === "loading"}
      />
    </div>
  );
}
