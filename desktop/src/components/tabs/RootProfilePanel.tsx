import { useState } from "react";
import { invoke } from "../../lib/tauri";
import type { RootProfile } from "../../lib/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useToast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * 白名单「配置组」的**展开面板**：组列表 + 切换 / 重命名 / 删除 / 新建。
 * 由 [RootProfilePill] 在标题行控制展开，本组件渲染在 `CardContent` 顶部。
 * 设计稿：design/白名单配置组入标题行-设计稿.html（方案 B）
 *
 * 安全边界（与后端一致）：组只是**存档**，当前生效集合永远是 `status.allowedRoots`。
 * 切换由人在面板上发起，远程 AI 无法自行换组——这四个命令只经 Tauri invoke 暴露，
 * 不是 MCP 工具。
 *
 * 原先有个「管理」按钮常驻在选择条上，点一下才显出重命名 / 删除。现在面板本身就是
 * 用户主动点开的，再套一层开关没有意义，所以去掉了 `managing` 态、两个按钮直接列出。
 * 行内切换点的是组名那个 button，与这两个按钮是并列的兄弟节点，不会误触。
 */
export function RootProfilePanel({
  profiles,
  active,
  onChanged,
  onClose,
}: {
  profiles: RootProfile[];
  active: string;
  /** 任何变更后重拉 status（组列表 / 当前组 / 生效目录都可能变）。 */
  onChanged: () => void;
  /** 切换成功后收起面板——目的已达成，没必要继续占着高度。 */
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [copyCurrent, setCopyCurrent] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 统一的调用包装：后端的拒绝理由（重名 / 当前组不可删等）直接弹给用户。 */
  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(okMsg, "success");
      onChanged();
      return true;
    } catch (e) {
      toast(String(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const doSwitch = async (name: string) => {
    if (name === active) {
      onClose();
      return;
    }
    const ok = await run(
      () => invoke("switch_root_profile", { name }),
      `已切到「${name}」`,
    );
    if (ok) onClose();
  };

  const doCreate = async () => {
    const ok = await run(
      () =>
        invoke("create_root_profile", {
          name: newName,
          copyCurrent,
          switch: true,
        }),
      `已创建并切到「${newName.trim()}」`,
    );
    if (ok) {
      setNewName("");
      setCreating(false);
      onClose();
    }
  };

  const doRename = async (oldName: string) => {
    const ok = await run(
      () => invoke("rename_root_profile", { oldName, newName: renameTo }),
      "已重命名",
    );
    if (ok) {
      setRenaming(null);
      setRenameTo("");
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {profiles.map((p) => (
        <div
          key={p.name}
          className={`flex items-center gap-2.5 border-b border-border/60 px-3 py-2 last:border-b-0 ${
            p.name === active ? "bg-primary/10" : ""
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              p.name === active ? "bg-primary" : "bg-border"
            }`}
          />
          {renaming === p.name ? (
            <>
              <Input
                value={renameTo}
                onChange={(e) => setRenameTo(e.target.value)}
                placeholder={p.name}
                className="h-7 flex-1 text-xs"
              />
              <Button size="sm" disabled={busy} onClick={() => doRename(p.name)}>
                保存
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRenaming(null)}>
                取消
              </Button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                disabled={busy}
                onClick={() => doSwitch(p.name)}
              >
                <span className="truncate text-xs font-semibold">{p.name}</span>
              </button>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {p.roots.length} 个目录{p.name === active ? " · 当前" : ""}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRenaming(p.name);
                  setRenameTo(p.name);
                }}
              >
                重命名
              </Button>
              {/* 当前组不给删除按钮：后端也会拒，但不该让用户先点再报错。 */}
              {p.name !== active && (
                <Button variant="outline" size="sm" onClick={() => setPendingDelete(p.name)}>
                  删除
                </Button>
              )}
            </>
          )}
        </div>
      ))}

      {/* 新建组 */}
      {creating ? (
        <div className="flex items-center gap-2 px-3 py-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="组名，如：NC 项目"
            className="h-7 flex-1 text-xs"
          />
          <label className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={copyCurrent}
              onChange={(e) => setCopyCurrent(e.target.checked)}
            />
            从当前组复制
          </label>
          <Button size="sm" disabled={busy || !newName.trim()} onClick={doCreate}>
            创建并切换
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCreating(false)}>
            取消
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className="w-full px-3 py-2 text-left text-xs font-semibold text-primary"
          onClick={() => setCreating(true)}
        >
          + 新建组
        </button>
      )}

      {/* ConfirmDialog 由父级条件渲染（它没有 open 属性），与 SecurityTab 删目录的用法一致。 */}
      {pendingDelete !== null && (
        <ConfirmDialog
          title="确定删除这个配置组？"
          variant="destructive"
          confirmLabel="删除"
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const name = pendingDelete!;
            setPendingDelete(null);
            await run(() => invoke("delete_root_profile", { name }), `已删除「${name}」`);
          }}
        >
          <p>
            将删除配置组 <code className="break-all">{pendingDelete}</code>。
          </p>
          <p className="mt-1.5 text-muted-foreground">
            只删这份目录清单，<b>不会动目录里的任何文件</b>；也不影响当前生效的白名单。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
