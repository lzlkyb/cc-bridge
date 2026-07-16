import { useState } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult } from "../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { DirectoryBrowser } from "../modals/DirectoryBrowser";
import { SecurityOverview } from "./SecurityOverview";
import { RunningCommandsCard } from "./RunningCommandsCard";
import { FileControlCard } from "./FileControlCard";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useToast } from "../ui/toast";

export function SecurityTab({
  status,
  onSaved,
}: {
  status?: StatusResponse;
  onSaved: () => void;
}) {
  const [newRoot, setNewRoot] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [rootSearch, setRootSearch] = useState("");
  const [pendingRemoveRoot, setPendingRemoveRoot] = useState<{ index: number; path: string } | null>(null);
  const { toast } = useToast();

  // H5 修复：之前失败时无 toast，finally 直接关 loading，用户不知道是否需要重试/路径是否合法。
  const addRoot = async (path?: string) => {
    const rootToAdd = path || newRoot.trim();
    if (!rootToAdd || !status) return;
    const roots = [...status.allowedRoots, rootToAdd];
    try {
      await invoke<ConfigSaveResult>("save_config", { patch: { allowedRoots: roots } });
      setNewRoot("");
      onSaved();
    } catch (e) {
      toast(`添加目录失败：${e}`, "error");
    }
  };

  const removeRoot = async (index: number) => {
    if (!status) return;
    const roots = status.allowedRoots.filter((_, i) => i !== index);
    try {
      await invoke<ConfigSaveResult>("save_config", { patch: { allowedRoots: roots } });
      onSaved();
    } catch (e) {
      toast(`删除目录失败：${e}`, "error");
    }
  };

  const filteredRoots = status?.allowedRoots.filter((r) =>
    rootSearch ? r.toLowerCase().includes(rootSearch.toLowerCase()) : true,
  ) ?? [];

  return (
    <div className="space-y-4">
      {/* 安全概览：核心开关内嵌 + 风险总览 */}
      <SecurityOverview status={status} onSaved={onSaved} />

      <RunningCommandsCard danger={status?.shellEnabled ?? false} />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <CardTitle icon={<Icon name="folder" />}>白名单根目录</CardTitle>
            {status && (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  status.whitelistEnabled
                    ? "bg-success/10 text-success"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {status.whitelistEnabled ? "校验已开启" : "校验已关闭"}
              </span>
            )}
          </div>
          {status && status.allowedRoots.length > 3 && (
            <div className="flex items-center gap-1.5 h-8 rounded-md border border-input bg-background px-2">
              <Icon name="search" size={13} className="text-muted-foreground shrink-0" />
              <input
                value={rootSearch}
                onChange={(e) => setRootSearch(e.target.value)}
                placeholder="搜索目录…"
                className="w-32 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {status?.allowedRoots.length === 0 && (
            <div className="relative flex flex-col items-center gap-2 py-6">
              <Icon name="folder" size={72} className="absolute opacity-[0.06] pointer-events-none" />
              <Icon name="folder" size={24} className="relative z-[1] text-muted-foreground/40" />
              <p className="relative z-[1] text-sm text-muted-foreground text-center max-w-[280px]">
                {status.whitelistEnabled
                  ? "添加工作目录后，远程 Claude Code 才能访问本地文件。"
                  : "白名单校验已关闭，远程可访问本机任意路径，无需添加目录。"}
              </p>
              <Button variant="outline" size="sm" className="relative z-[1] mt-1" onClick={() => setBrowserOpen(true)}>
                <Icon name="folder" size={14} />
                添加第一个目录
              </Button>
            </div>
          )}
          {rootSearch && filteredRoots.length === 0 && status && status.allowedRoots.length > 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">没有匹配的目录</p>
          )}
          {filteredRoots.map((root, i) => {
            const realIndex = status?.allowedRoots.indexOf(root) ?? i;
            return (
              <div key={root} className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-muted px-3 py-1.5 text-xs font-mono truncate">{root}</code>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setPendingRemoveRoot({ index: realIndex, path: root })}>
                  <Icon name="trash" size={14} />
                  删除
                </Button>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <Input
              value={newRoot}
              onChange={(e) => setNewRoot(e.target.value)}
              placeholder="输入目录路径..."
              onKeyDown={(e) => e.key === "Enter" && addRoot()}
              className="min-w-0 flex-1"
            />
            <Button variant="outline" size="sm" onClick={() => setBrowserOpen(true)}>
              <Icon name="folder" size={14} />
              浏览
            </Button>
            <Button size="sm" onClick={() => addRoot()}>
              <Icon name="plus" size={14} />
              添加
            </Button>
          </div>
        </CardContent>
      </Card>

      <FileControlCard status={status} onSaved={onSaved} />

      <DirectoryBrowser
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onSelect={(path) => {
          setBrowserOpen(false);
          addRoot(path);
        }}
      />

      {pendingRemoveRoot && (
        <ConfirmDialog
          title="确定删除这个白名单目录？"
          description={
            <>
              <code className="break-all">{pendingRemoveRoot.path}</code> 将从白名单中移除，远程 Claude Code 将立即
              失去该目录的访问权限。
            </>
          }
          variant="destructive"
          confirmLabel="确定删除"
          onCancel={() => setPendingRemoveRoot(null)}
          onConfirm={() => {
            const index = pendingRemoveRoot.index;
            setPendingRemoveRoot(null);
            void removeRoot(index);
          }}
        />
      )}
    </div>
  );
}
