import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult, RunningCommandInfo } from "../../lib/types";
import { formatUptime } from "../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { DirectoryBrowser } from "../modals/DirectoryBrowser";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";

export function SecurityTab({
  status,
  onSaved,
}: {
  status?: StatusResponse;
  onSaved: () => void;
}) {
  const [newRoot, setNewRoot] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [lastSavedField, setLastSavedField] = useState("");
  const [rootSearch, setRootSearch] = useState("");

  const showSaved = useCallback((field: string) => {
    setLastSavedField(field);
    setTimeout(() => setLastSavedField(""), 1500);
  }, []);

  const saveField = useCallback(async (patch: Record<string, unknown>, fieldName: string) => {
    await invoke<ConfigSaveResult>("save_config", { patch });
    onSaved();
    showSaved(fieldName);
  }, [onSaved, showSaved]);

  const addRoot = async (path?: string) => {
    const rootToAdd = path || newRoot.trim();
    if (!rootToAdd || !status) return;
    const roots = [...status.allowedRoots, rootToAdd];
    await invoke<ConfigSaveResult>("save_config", { patch: { allowedRoots: roots } });
    setNewRoot("");
    onSaved();
  };

  const removeRoot = async (index: number) => {
    if (!status) return;
    const roots = status.allowedRoots.filter((_, i) => i !== index);
    await invoke<ConfigSaveResult>("save_config", { patch: { allowedRoots: roots } });
    onSaved();
  };

  const filteredRoots = status?.allowedRoots.filter((r) =>
    rootSearch ? r.toLowerCase().includes(rootSearch.toLowerCase()) : true
  ) ?? [];

  return (
    <div className="space-y-3">
      {/* 白名单关闭 / 只读开启时的常驻警示条 */}
      {status && !status.whitelistEnabled && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
          <Icon name="alertTriangle" size={16} className="mt-0.5 shrink-0" />
          <div>
            <b>路径白名单校验已关闭。</b>远程 Claude Code 可读写本机<b>任意路径</b>。
            仅在完全信任网络环境时使用，用完请在「设置 → 功能开关」中开回。
          </div>
        </div>
      )}
      {status?.shellEnabled && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
          <Icon name="terminal" size={16} className="mt-0.5 shrink-0" />
          <div>
            <b>命令执行已开启。</b>远程 Claude Code 可在白名单目录内执行<b>任意 Shell 命令</b>（等同 RCE）。
            仅在完全信任的网络环境中使用，用完请在「设置 → 功能开关」中关闭。
          </div>
        </div>
      )}
      {status?.readonlyMode && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-xs text-warning">
          <Icon name="lock" size={16} className="mt-0.5 shrink-0" />
          <div>
            <b>只读模式已开启。</b>所有写入 / 删除 / 移动 / 复制请求将被拒绝。
          </div>
        </div>
      )}

      <RunningCommandsCard />

      <div className="divider-grad" />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
          <CardTitle icon={<Icon name="folder" />}>白名单根目录</CardTitle>
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
                添加工作目录后，远程 Claude Code 才能访问本地文件。
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
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => removeRoot(realIndex)}>
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

      <div className="divider-grad" />

      <Card>
        <CardHeader>
          <CardTitle icon={<Icon name="shield" />}>安全设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <AutoSaveField
              label="允许的扩展名（逗号分隔，留空不限制）"

              initial={status?.allowedExtensions.join(", ") ?? ""}
              saved={lastSavedField === "extensions"}
              onSave={(val) => {
                const extList = val.split(",").map((e) => e.trim()).filter(Boolean);
                return saveField({ allowedExtensions: extList }, "extensions");
            }}
          />
          {/* 预设快捷填充 */}
          <div className="flex flex-wrap gap-1.5">
            {([
              { label: "前端常用", value: ".js, .jsx, .ts, .tsx, .css, .html, .json" },
              { label: "后端常用", value: ".java, .py, .go, .rs, .rb, .php" },
              { label: "配置文件", value: ".yaml, .yml, .toml, .ini, .env, .conf" },
              { label: "文档类", value: ".md, .txt, .csv, .log" },
            ] as const).map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  const current = status?.allowedExtensions.join(", ") ?? "";
                  const val = current ? current + ", " + preset.value : preset.value;
                  saveField({ allowedExtensions: val.split(",").map((e) => e.trim()).filter(Boolean) }, "extensions");
                }}
                className="inline-flex items-center gap-1 rounded-full border bg-background px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
              >
                <Icon name="plus" size={10} />
                {preset.label}
              </button>
            ))}
          </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <AutoSaveNumber
              label="文件大小上限 (MB)"

              initial={status ? Math.round(status.maxFileSizeBytes / 1024 / 1024) : 20}
              saved={lastSavedField === "maxFileSize"}
              onSave={(val) => saveField({ maxFileSizeBytes: val * 1024 * 1024 }, "maxFileSize")}
            />
            <AutoSaveNumber
              label="备份保留份数"

              initial={status?.backupRetention ?? 10}
              saved={lastSavedField === "backupRetention"}
              onSave={(val) => saveField({ backupRetention: val }, "backupRetention")}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <AutoSaveNumber
              label="限流上限（次/窗口）"

              initial={status?.rateLimit.maxRequests ?? 100}
              saved={lastSavedField === "rateMaxReq"}
              onSave={(val) => saveField({ rateLimitMaxRequests: val }, "rateMaxReq")}
            />
            <AutoSaveNumber
              label="限流窗口（秒）"

              initial={status ? status.rateLimit.windowMs / 1000 : 60}
              saved={lastSavedField === "rateWindow"}
              onSave={(val) => saveField({ rateLimitWindowMs: val * 1000 }, "rateWindow")}
            />
          </div>
          <AutoSaveField
            label="备份目录"

            initial={status?.backupDir ?? ""}
            saved={lastSavedField === "backupDir"}
            onSave={(val) => saveField({ backupDir: val }, "backupDir")}
          />
          <p className="text-xs text-muted-foreground">
            所有设置修改后自动保存，无需手动提交。
          </p>
        </CardContent>
      </Card>

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

/**
 * 运行中的后台命令（run_command(background=true) 启动）。与远程的
 * get_command_output 读取同一份注册表，让本机面板也能看到并一键终止。
 * 无后台命令时不渲染，避免空卡片占地。
 */
function RunningCommandsCard() {
  const { data: commands, refetch } = useQuery<RunningCommandInfo[]>({
    queryKey: ["runningCommands"],
    queryFn: () => invoke<RunningCommandInfo[]>("list_running_commands"),
    refetchInterval: 3000,
  });

  const stop = async (handle: string) => {
    await invoke("stop_running_command", { handle });
    refetch();
  };

  if (!commands || commands.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="terminal" />}>运行中的后台命令</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[80px]">PID</TableHead>
              <TableHead>命令</TableHead>
              <TableHead className="w-[90px]">已运行</TableHead>
              <TableHead className="w-[70px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {commands.map((cmd, i) => (
              <TableRow key={cmd.handle} className={i % 2 === 0 ? "bg-muted/20" : ""}>
                <TableCell className="font-mono text-xs">{cmd.pid}</TableCell>
                <TableCell className="truncate font-mono text-xs" title={cmd.command}>
                  {cmd.command}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatUptime(cmd.elapsedSeconds)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => stop(cmd.handle)}
                  >
                    <Icon name="power" size={14} />
                    终止
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ─── Auto-save field components ─── */

function AutoSaveField({
  label,
  initial,
  saved,
  onSave,
}: {
  label: string;
  initial: string;
  saved: boolean;
  onSave: (val: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const initialized = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!initialized.current) {
      setValue(initial);
      initialized.current = !!initial;
    }
  }, [initial]);

  const handleChange = (val: string) => {
    setValue(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSave(val), 800);
  };

  const handleBlur = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    onSave(value);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        {saved && <span className="text-xs text-success">已保存 ✓</span>}
      </div>
      <Input
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
      />
    </div>
  );
}

function AutoSaveNumber({
  label,
  initial,
  saved,
  onSave,
}: {
  label: string;
  initial: number;
  saved: boolean;
  onSave: (val: number) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const initialized = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!initialized.current) {
      setValue(initial);
      initialized.current = initial !== 0;
    }
  }, [initial]);

  const handleChange = (val: number) => {
    setValue(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSave(val), 800);
  };

  const handleBlur = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    onSave(value);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        {saved && <span className="text-xs text-success">已保存 ✓</span>}
      </div>
      <Input
        type="number"
        value={value}
        onChange={(e) => handleChange(Number(e.target.value))}
        onBlur={handleBlur}
      />
    </div>
  );
}
