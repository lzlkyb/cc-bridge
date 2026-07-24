import { useState } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult } from "../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Icon } from "../ui/icon";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SavedHint } from "../ui/SavedHint";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useToast } from "../ui/toast";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";

/**
 * 「命令白名单」卡（④P0-1 Layer 2）。仅当命令执行（shellEnabled）开启时才可配置——
 * 否则白名单无意义（根本不会执行命令）。三个状态：
 *   ① shellEnabled 未开 → 整卡锁定提示，引导去「安全概览」开启命令执行；
 *   ② 已开但白名单关 → 仅开关（远程可执行任意程序，受 Layer 1 兜底）；
 *   ③ 已开且白名单开 → 程序列表增删（大小写不敏感、按 basename 匹配）。
 * 注意：Layer 1 破坏性拦截不被白名单绕过——即便把 rm 列入白名单，rm -rf C:\Windows 仍被拦。
 */
export function CommandAllowlistCard({
  status,
  onSaved,
}: {
  status?: StatusResponse;
  onSaved: () => void;
}) {
  const shellOn = status?.shellEnabled ?? false;
  const allowOn = status?.commandAllowlistEnabled ?? false;
  const allowlist = status?.commandAllowlist ?? [];
  const [newProg, setNewProg] = useState("");
  const [progSearch, setProgSearch] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const { toast } = useToast();
  // 列表增删/筛选时 FLIP 平滑进出场与位移（动画质感升级；减弱动效时自动关闭）。
  const listParent = useAutoAnimateRM<HTMLDivElement>();

  const showSaved = (key: string) => {
    setSavedKey(key);
    setTimeout(() => setSavedKey((cur) => (cur === key ? null : cur)), 1500);
  };

  const save = async (patch: Record<string, unknown>, key?: string) => {
    try {
      await invoke<ConfigSaveResult>("save_config", { patch });
      onSaved();
      if (key) showSaved(key);
    } catch (e) {
      toast(`保存失败：${e}`, "error");
    }
  };

  const setAllow = (next: boolean) => save({ commandAllowlistEnabled: next }, "allowlist");

  const addProg = async () => {
    const p = newProg.trim();
    if (!p || !status) return;
    const norm = p.toLowerCase();
    if (allowlist.some((a) => a.toLowerCase() === norm)) {
      toast("该程序已在白名单中", "error");
      return;
    }
    const next = [...allowlist, p];
    try {
      await invoke<ConfigSaveResult>("save_config", { patch: { commandAllowlist: next } });
      setNewProg("");
      onSaved();
    } catch (e) {
      toast(`添加失败：${e}`, "error");
    }
  };

  const removeProg = async (prog: string) => {
    if (!status) return;
    // 按程序名值删除（大小写敏感匹配存储值），避免下标过期删错项。
    const next = allowlist.filter((a) => a !== prog);
    try {
      await invoke<ConfigSaveResult>("save_config", { patch: { commandAllowlist: next } });
      onSaved();
    } catch (e) {
      toast(`删除失败：${e}`, "error");
    }
  };

  const filtered = progSearch
    ? allowlist.filter((a) => a.toLowerCase().includes(progSearch.toLowerCase()))
    : allowlist;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <CardTitle icon={<Icon name="terminal" />}>命令白名单</CardTitle>
          {status && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                !shellOn
                  ? "bg-muted text-muted-foreground"
                  : allowOn
                    ? "bg-success/10 text-success"
                    : "bg-warning/10 text-warning"
              }`}
            >
              {!shellOn ? "命令执行未开启" : allowOn ? "已启用" : "未启用"}
            </span>
          )}
        </div>
        {status && shellOn && allowOn && allowlist.length > 3 && (
          <div className="flex items-center gap-1.5 h-8 rounded-md border border-input bg-background px-2">
            <Icon name="search" size={13} className="text-muted-foreground shrink-0" />
            <input
              value={progSearch}
              onChange={(e) => setProgSearch(e.target.value)}
              placeholder="搜索程序…"
              className="w-32 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!shellOn ? (
          <div className="relative flex flex-col items-center gap-2 py-6 text-center">
            <Icon name="lock" size={24} className="text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground max-w-[320px]">
              命令执行尚未开启，白名单暂不需配置。如需限制可执行程序，请先在上方
              「安全概览」开启命令执行。
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 py-1">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">启用命令白名单</span>
                  {savedKey === "allowlist" && <SavedHint>已保存</SavedHint>}
                </div>
                <div className={`mt-0.5 text-xs ${allowOn ? "text-muted-foreground" : "text-warning"}`}>
                  {allowOn
                    ? "仅允许白名单内程序执行命令，其余一律拒绝（不削弱 Layer 1 破坏性拦截）"
                    : "未启用 · 远程可执行任意程序，仅受 Layer 1 破坏性拦截兜底"}
                </div>
              </div>
              <Switch checked={allowOn} onChange={setAllow} ariaLabel="启用命令白名单" />
            </div>

            {allowOn && (
              <>
                <div className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs leading-relaxed text-foreground">
                  <Icon name="info" size={15} className="mt-0.5 shrink-0 text-primary" />
                  <span>
                    白名单按程序名（大小写不敏感）匹配。即使列入{" "}
                    <code className="rounded bg-background/60 px-1 font-mono text-[11px]">rm</code>，
                    <b>Layer 1 破坏性拦截仍生效</b>——{" "}
                    <code className="rounded bg-background/60 px-1 font-mono text-[11px]">
                      rm -rf C:\Windows
                    </code>{" "}
                    依然会被拦截。
                  </span>
                </div>

                {allowlist.length === 0 && (
                  <div className="relative flex flex-col items-center gap-2 py-6">
                    <Icon name="terminal" size={24} className="relative z-[1] text-muted-foreground/40" />
                    <p className="relative z-[1] text-sm text-muted-foreground text-center max-w-[280px]">
                      白名单为空，所有命令执行都会被拒绝。添加常用程序（如 git、cargo、npm）。
                    </p>
                  </div>
                )}
                {progSearch && filtered.length === 0 && allowlist.length > 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">没有匹配的程序</p>
                )}
                <div ref={listParent} className="space-y-2">
                  {filtered.map((prog) => (
                    <div key={prog} className="flex items-center gap-2">
                      <code className="flex-1 rounded-md bg-muted px-3 py-1.5 text-xs font-mono truncate">
                        {prog}
                      </code>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setPendingRemove(prog)}
                      >
                        <Icon name="trash" size={14} />
                        删除
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={newProg}
                    onChange={(e) => setNewProg(e.target.value)}
                    placeholder="输入程序名，如 git / cargo / npm"
                    onKeyDown={(e) => e.key === "Enter" && addProg()}
                    className="min-w-0 flex-1"
                  />
                  <Button size="sm" onClick={() => addProg()}>
                    <Icon name="plus" size={14} />
                    添加
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>

      {pendingRemove && (
        <ConfirmDialog
          title="确定从命令白名单移除？"
          description={
            <>
              <code className="break-all">{pendingRemove}</code> 将被移出白名单，此后远程执行以它为程序名的命令会被拒绝。
            </>
          }
          variant="destructive"
          confirmLabel="确定删除"
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            const prog = pendingRemove;
            setPendingRemove(null);
            void removeProg(prog);
          }}
        />
      )}
    </Card>
  );
}
