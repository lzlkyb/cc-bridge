import { useState } from "react";
import { invoke } from "../../../lib/tauri";
import type { StatusResponse, ConfigSaveResult } from "../../../lib/types";
import { APP_INFO } from "../../../lib/about";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { DirectoryBrowser } from "../DirectoryBrowser";
import { useToast } from "../../ui/toast";

/**
 * 引导第 1 步：添加白名单根目录。
 * 复用 SecurityTab 的添加逻辑（append + save_config），让用户在向导内就能完成
 * 「告诉 cc-bridge 远程能访问哪些目录」这一最关键的首次动作。
 */
export function StepAddDir({
  status,
  onRefresh,
}: {
  status?: StatusResponse;
  onRefresh: () => void;
}) {
  const [newRoot, setNewRoot] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  // H5 修复：之前失败时无 toast，finally 直接关 loading，用户不知道是否需要重试/路径是否合法。
  const addRoot = async (path?: string) => {
    const rootToAdd = path || newRoot.trim();
    if (!rootToAdd || !status) return;
    // 去重：已存在则不重复添加，避免白名单重复条目与重复 React key。
    if (status.allowedRoots.includes(rootToAdd)) {
      toast("该目录已在白名单中", "info");
      setNewRoot("");
      return;
    }
    const roots = [...status.allowedRoots, rootToAdd];
    setBusy(true);
    try {
      await invoke<ConfigSaveResult>("save_config", { patch: { allowedRoots: roots } });
      setNewRoot("");
      onRefresh();
    } catch (e) {
      toast(`添加目录失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const removeRoot = async (index: number) => {
    if (!status) return;
    const roots = status.allowedRoots.filter((_, i) => i !== index);
    setBusy(true);
    try {
      await invoke<ConfigSaveResult>("save_config", { patch: { allowedRoots: roots } });
      onRefresh();
    } catch (e) {
      toast(`删除目录失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const roots = status?.allowedRoots ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        先告诉 {APP_INFO.name} 远程的 Claude Code 能访问哪些<b className="text-foreground">本地</b>文件夹。这是安全锁——AI 只能读写你勾选的目录，其余文件碰不到。
      </p>

      {roots.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center">
          <Icon name="folder" size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">还没添加任何目录</p>
        </div>
      ) : (
        <div className="space-y-2">
          {roots.map((root, i) => (
            <div key={root} className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-muted px-3 py-1.5 text-xs font-mono">{root}</code>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => removeRoot(i)}
                disabled={busy}
              >
                <Icon name="trash" size={14} /> 删除
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          value={newRoot}
          onChange={(e) => setNewRoot(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addRoot()}
          placeholder="输入目录路径，如 D:\Projects\my-app"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button variant="outline" size="sm" onClick={() => setBrowserOpen(true)} disabled={busy}>
          <Icon name="folder" size={14} /> 浏览
        </Button>
        <Button size="sm" onClick={() => addRoot()} disabled={busy || !newRoot.trim()}>
          <Icon name="plus" size={14} /> 添加
        </Button>
      </div>

      <DirectoryBrowser
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onSelect={(path) => {
          setBrowserOpen(false);
          addRoot(path);
        }}
      />
    </div>
  );
}
