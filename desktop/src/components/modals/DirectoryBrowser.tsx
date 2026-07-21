import { useState, useEffect, useCallback } from "react";
import { invoke } from "../../lib/tauri";
import type { BrowseResult, BrowseEntry } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/toast";

export function DirectoryBrowser({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    try {
      const result = await invoke<BrowseResult>("browse_directory", {
        path: path ?? null,
      });
      setCurrentPath(result.path ?? null);
      setParentPath(result.parent ?? null);
      setEntries(result.entries);
    } catch (e) {
      // 之前仅 console.error，用户看不到任何反馈（目录无权限/不存在时静默失败）。
      console.error("Browse error:", e);
      toast(`无法浏览目录：${e}`, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open && entries.length === 0 && !loading && currentPath === null) {
      browse();
    }
  }, [open, entries.length, loading, currentPath, browse]);

  return (
    <Modal open={open} onClose={onClose} zIndex={50} className="mx-4 w-full max-w-lg rounded-xl modal-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <span className="title-chip"><Icon name="folder" /></span>
            选择目录
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <Icon name="close" size={18} />
          </button>
        </div>

        {currentPath && (
          <div className="mb-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded-md bg-muted px-2 py-1 text-xs" title={currentPath}>{currentPath}</code>
            <Button size="sm" onClick={() => onSelect(currentPath)}>
              选择此目录
            </Button>
          </div>
        )}

        <div className="mb-2 flex gap-2">
          {parentPath && (
            <Button variant="outline" size="sm" onClick={() => browse(parentPath)}>
              <Icon name="arrowUp" size={14} />
              上级目录
            </Button>
          )}
          {currentPath && (
            <Button variant="outline" size="sm" onClick={() => { setCurrentPath(null); setParentPath(null); browse(); }}>
              回到根目录
            </Button>
          )}
        </div>

        <div className="max-h-64 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">加载中...</div>
          ) : entries.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">空目录</div>
          ) : (
            entries.map((entry, i) => (
              <button
                key={i}
                onClick={() => browse(entry.path)}
                className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-muted"
              >
                <Icon name="folder" size={15} className="text-primary shrink-0" />
                <span className="truncate" title={entry.name}>{entry.name}</span>
              </button>
            ))
          )}
        </div>
    </Modal>
  );
}
