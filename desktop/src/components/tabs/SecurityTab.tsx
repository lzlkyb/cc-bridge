import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult, RunningCommandInfo, CommandOutput, BackupListResult, BackupFileInfo } from "../../lib/types";
import { formatUptime, formatBytes } from "../../lib/utils";
import { VersionHistoryModal } from "../backup/VersionHistoryModal";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { DirectoryBrowser } from "../modals/DirectoryBrowser";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Badge } from "../ui/badge";
import { SecurityOverview } from "./SecurityOverview";
import { ChipInput } from "../ui/chip-input";

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

  // ── 备份查看（P0 统计/路径 · P1 清单/还原 · 版本历史弹框）──
  const [historyOpen, setHistoryOpen] = useState(false);
  const [backups, setBackups] = useState<BackupListResult | null>(null);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoreEntry, setRestoreEntry] = useState<BackupFileInfo | null>(null);

  const handleOpenBackupDir = async () => {
    try {
      await invoke("reveal_backup_dir");
    } catch (e) {
      console.error("[备份] 打开目录失败:", e);
    }
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    // 首次打开时懒加载（不占首屏），之后复用缓存
    if (!backups && !loadingBackups) {
      setLoadingBackups(true);
      try {
        const r = await invoke<BackupListResult>("list_backups");
        setBackups(r);
      } catch (e) {
        console.error("[备份] 列出失败:", e);
      } finally {
        setLoadingBackups(false);
      }
    }
  };

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
    <div className="space-y-4">
      {/* 安全概览：核心开关内嵌 + 风险总览（方案 A） */}
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

      <Card>
        <CardHeader>
          <CardTitle icon={<Icon name="shield" />}>文件管控</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <ChipInput
              value={status?.allowedExtensions ?? []}
              onChange={(vals) => {
                saveField({ allowedExtensions: vals }, "extensions");
              }}
            />
            <p className="text-xs text-muted-foreground">
              留空表示不限制扩展名；所有设置修改后自动保存。
            </p>
          </div>

          <div className="my-3.5 h-px bg-border" />

          {/* ══ 备份 — PastePanda 行式 ══ */}
          <div className="s-sec-label">备份</div>

          <div className="s-row group">
            <span className="title-chip"><Icon name="file" size={15} aria-hidden="true" /></span>
            <div className="s-body">
              <div className="s-label">文件大小上限</div>
              <div className="s-row-desc">超过上限的文件自动截断</div>
            </div>
            <div className="s-right">
              <InlineNum
                value={status ? Math.round(status.maxFileSizeBytes / 1024 / 1024) : 20}
                saved={lastSavedField === "maxFileSize"}
                unit="MB"
                onSave={(v) => saveField({ maxFileSizeBytes: v * 1024 * 1024 }, "maxFileSize")}
              />
            </div>
          </div>

          <div className="s-row-divider" />

          <div className="s-row group">
            <span className="title-chip"><Icon name="history" size={15} aria-hidden="true" /></span>
            <div className="s-body">
              <div className="s-label">备份保留份数</div>
              <div className="s-row-desc">
                同一文件最多保留最近 N 份（按编辑次数累积，
                <span className="font-medium text-foreground">非按天</span>）
              </div>
            </div>
            <div className="s-right">
              <InlineNum
                value={status?.backupRetention ?? 10}
                saved={lastSavedField === "backupRetention"}
                unit="份"
                onSave={(v) => saveField({ backupRetention: v }, "backupRetention")}
              />
            </div>
          </div>

          <div className="s-row-divider" />

          <div className="s-row group">
            <span className="title-chip"><Icon name="folder" size={15} aria-hidden="true" /></span>
            <div className="s-body">
              <div className="s-label">备份目录</div>
              <div className="s-row-desc font-mono text-[11px] break-all" title={status?.backupDirAbs}>
                {status?.backupDirAbs || status?.backupDir || "未设置"}
              </div>
            </div>
            <div className="s-right">
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenBackupDir}
                disabled={!status?.backupDirAbs}
              >
                <Icon name="folder" size={14} />
                打开文件夹
              </Button>
            </div>
          </div>
          <p className="s-row-desc px-2.5 pb-1 text-[10.5px]">
            备份仅存于本机该目录，远程 Claude Code 无法读取；目录名由程序固定管理，无需手动修改。
          </p>

          {/* P0：实时统计 + 规则说明 */}
          <div className="mt-1 flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
            <span>
              共 <span className="font-semibold">{status?.backupCount ?? 0}</span> 个备份 · 占用{" "}
              <span className="font-semibold">{formatBytes(status?.backupTotalBytes ?? 0)}</span>
            </span>
          </div>
          <div className="mt-2.5 flex gap-2.5 rounded-lg border border-primary/25 bg-primary/10 p-3 text-xs leading-relaxed text-foreground">
            <Icon name="info" size={15} className="mt-0.5 shrink-0 text-primary" />
            <div>
              <b className="text-primary">备份怎么产生的？</b> 你（或远程会话）每次
              <b>改写 / 删除一个已存在的受保护文件</b>前，程序会自动把原文件复制一份到上面的目录，命名为
              <code className="mx-0.5 rounded bg-background/60 px-1 font-mono text-[11px]">原文件名.时间戳.bak</code>
              。同一文件被改多次会留多个版本，<b>只按份数保留最近 N 份，与日期无关</b>。
            </div>
          </div>

          {/* 版本历史：打开居中弹框（检索/导航 + 版本时间线 + 相邻对比 + 还原） */}
          <button
            type="button"
            className="mt-3 flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-3 text-left transition-colors hover:bg-muted"
            onClick={openHistory}
          >
            <span className="title-chip">
              <Icon name="history" size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-foreground">版本历史</div>
              <div className="truncate text-[11px] text-muted-foreground">
                浏览备份快照 · 查看改动 · 对比相邻版本 · 还原
              </div>
            </div>
            <span className="shrink-0 text-xs font-semibold text-primary">
              打开
              <Icon name="chevronRight" size={14} className="ml-0.5 inline" />
            </span>
          </button>

          <VersionHistoryModal
            open={historyOpen}
            status={status}
            result={backups}
            loading={loadingBackups}
            onClose={() => setHistoryOpen(false)}
            onRestore={(entry) => setRestoreEntry(entry)}
          />

          <div className="my-3.5 h-px bg-border" />

          {/* ══ 请求限流 — PastePanda 合并行 ══ */}
          <div className="s-sec-label">请求限流</div>

          <div className="s-row group">
            <span className="title-chip"><Icon name="sliders" size={15} aria-hidden="true" /></span>
            <div className="s-body">
              <div className="s-label">请求限制</div>
              <div className="s-row-desc">
                当前：每 {status ? status.rateLimit.windowMs / 1000 : 60}s 最多 {status?.rateLimit.maxRequests ?? 100} 次，超出拒绝
              </div>
            </div>
            <div className="s-right">
              <InlineNum
                value={status?.rateLimit.maxRequests ?? 100}
                saved={lastSavedField === "rateMaxReq"}
                unit="次 /"
                onSave={(v) => saveField({ rateLimitMaxRequests: v }, "rateMaxReq")}
              />
              <InlineNum
                value={status ? status.rateLimit.windowMs / 1000 : 60}
                saved={lastSavedField === "rateWindow"}
                unit="秒"
                onSave={(v) => saveField({ rateLimitWindowMs: v * 1000 }, "rateWindow")}
              />
            </div>
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
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

      {restoreEntry && (
        <RestoreBackupDialog entry={restoreEntry} onClose={() => setRestoreEntry(null)} />
      )}
    </div>
  );
}

/**
 * 运行中的后台命令（run_command(background=true) 启动）。与远程的
 * get_command_output 读取同一份注册表，让本机面板也能看到并一键终止。
 * 无后台命令时不渲染，避免空卡片占地。
 * danger：命令执行已开启时整卡高亮红边 + 提醒，引导用户确认进程可信。
 */
function RunningCommandsCard({ danger = false }: { danger?: boolean }) {
  const { data: commands, refetch } = useQuery<RunningCommandInfo[]>({
    queryKey: ["runningCommands"],
    queryFn: () => invoke<RunningCommandInfo[]>("list_running_commands"),
    refetchInterval: 3000,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (handle: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });

  const stop = async (handle: string) => {
    await invoke("stop_running_command", { handle });
    refetch();
  };

  if (!commands || commands.length === 0) return null;

  return (
    <Card className={danger ? "border-destructive/30" : ""}>
      <CardHeader>
        <CardTitle icon={<Icon name="terminal" />}>运行中的后台命令</CardTitle>
        <p className="text-xs text-muted-foreground">
          已结束的命令会保留 5 分钟供查看输出（看右侧“状态”区分是否还在跑），之后自动清理。
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[80px]">PID</TableHead>
              <TableHead>命令</TableHead>
              <TableHead className="w-[76px]">状态</TableHead>
              <TableHead className="w-[90px]">已运行</TableHead>
              <TableHead className="w-[210px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {commands.map((cmd, i) => (
              <Fragment key={cmd.handle}>
                <TableRow className={i % 2 === 0 ? "bg-muted/20" : ""}>
                  <TableCell className="font-mono text-xs">{cmd.pid}</TableCell>
                  <TableCell className="truncate font-mono text-xs" title={cmd.command}>
                    {cmd.command}
                  </TableCell>
                  <TableCell>
                    <CommandStatusBadge running={cmd.running} exitCode={cmd.exitCode} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatUptime(cmd.elapsedSeconds)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-nowrap items-center gap-1 whitespace-nowrap">
                      <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={() => toggle(cmd.handle)}>
                        <Icon name={expanded.has(cmd.handle) ? "chevronUp" : "chevronDown"} size={14} />
                        {expanded.has(cmd.handle) ? "收起" : "查看输出"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="whitespace-nowrap text-destructive hover:text-destructive"
                        onClick={() => stop(cmd.handle)}
                      >
                        <Icon name="power" size={14} />
                        终止
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                {expanded.has(cmd.handle) && (
                  <TableRow className="bg-muted/5">
                    <TableCell colSpan={5} className="p-0">
                      <CommandOutputPanel handle={cmd.handle} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
        {danger && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive">
            <Icon name="alertTriangle" size={13} className="mt-0.5 shrink-0" />
            命令执行已开启，请确认以上进程均来自你信任的会话。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 后台命令状态徽章：区分“还在跑”/“已成功结束”/“已失败结束”三种状态，
 * 避免用户把处于 5 分钟清理宽限期内的已结束命令误以为还在运行。
 */
function CommandStatusBadge({
  running,
  exitCode,
}: {
  running: boolean;
  exitCode: number | null;
}) {
  if (running) {
    return <Badge variant="default">运行中</Badge>;
  }
  if (exitCode === 0) {
    return <Badge variant="success">已结束</Badge>;
  }
  return (
    <Badge variant="destructive">{exitCode != null ? `失败 (${exitCode})` : "已结束"}</Badge>
  );
}

/**
 * 单条后台命令的实时输出面板。
 * 点「查看输出」展开时挂载：每 1.5s 增量拉取 get_command_output，按 stdoutOffset /
 * stderrOffset 追加（ref 保存 offset，effect 仅在 handle 变化时重建），避免大文本反复重渲。
 * 命令结束后停止轮询，历史输出仍可查看，方便事后排查。
 */
function CommandOutputPanel({ handle }: { handle: string }) {
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [meta, setMeta] = useState<{
    running: boolean;
    exitCode: number | null;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    stdoutTotalBytes: number;
    stderrTotalBytes: number;
  } | null>(null);
  const offsets = useRef({ stdout: 0, stderr: 0 });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const poll = async () => {
      try {
        const out = await invoke<CommandOutput>("get_command_output", {
          handle,
          stdoutOffset: offsets.current.stdout,
          stderrOffset: offsets.current.stderr,
        });
        if (cancelled) return;
        if (out.stdout) setStdout((s) => s + out.stdout);
        if (out.stderr) setStderr((s) => s + out.stderr);
        offsets.current.stdout = out.stdoutTotalBytes;
        offsets.current.stderr = out.stderrTotalBytes;
        setMeta({
          running: out.running,
          exitCode: out.exitCode,
          stdoutTruncated: out.stdoutTruncated,
          stderrTruncated: out.stderrTruncated,
          stdoutTotalBytes: out.stdoutTotalBytes,
          stderrTotalBytes: out.stderrTotalBytes,
        });
        if (!out.running && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      } catch {
        // handle 已被清理或读取失败：停止轮询，避免无意义重试。
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
      }
    };

    poll();
    timer = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [handle]);

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        {meta?.running ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
            运行中
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            已结束
            {meta && meta.exitCode !== null && meta.exitCode !== undefined
              ? ` · ExitCode ${meta.exitCode}`
              : ""}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground">实时输出（1.5s 刷新）</span>
      </div>
      {meta && (meta.stdoutTruncated || meta.stderrTruncated) && (
        <p className="flex items-center gap-1.5 text-[11px] text-warning">
          <Icon name="alertTriangle" size={12} />
          输出已超过 1MB 上限，早期内容已自动截断。
        </p>
      )}
      <LogBox
        label="标准输出 (stdout)"
        text={stdout}
        bytes={meta?.stdoutTotalBytes ?? 0}
        truncated={meta?.stdoutTruncated ?? false}
      />
      {stderr && (
        <LogBox
          label="标准错误 (stderr)"
          text={stderr}
          bytes={meta?.stderrTotalBytes ?? 0}
          truncated={meta?.stderrTruncated ?? false}
          isError
        />
      )}
    </div>
  );
}

/** 终端风格日志框：固定高度独立滚动 + 自动滚到底部，stdout 普通色、stderr 危险色。 */
function LogBox({
  label,
  text,
  bytes,
  truncated,
  isError,
}: {
  label: string;
  text: string;
  bytes: number;
  truncated: boolean;
  isError?: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {label} · {bytes.toLocaleString()} 字节
        </span>
        {truncated && <span className="text-warning">已截断</span>}
      </div>
      <pre
        ref={ref}
        className={`max-h-[200px] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-[#0d1117] p-2.5 font-mono text-[11px] leading-relaxed ${
          isError ? "text-destructive" : "text-[#d4d4d4]"
        }`}
      >
        {text || <span className="opacity-40">（暂无输出）</span>}
      </pre>
    </div>
  );
}

/* ══ 行内数字输入（PastePanda 风格） ══ */
function InlineNum({
  value: initial,
  saved,
  unit,
  onSave,
}: {
  value: number; saved: boolean; unit: string;
  onSave: (v: number) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const initialized = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!initialized.current) { setValue(initial); initialized.current = initial !== 0; }
  }, [initial]);
  const handleChange = (v: number) => {
    setValue(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSave(v), 800);
  };
  return (
    <div className="flex items-center gap-1.5">
      <input type="number" className="s-input" value={value}
        onChange={(e) => handleChange(Number(e.target.value))}
        onBlur={() => { if (debounceRef.current) { clearTimeout(debounceRef.current); onSave(value); } }}
      />
      <span className="s-unit">{unit}</span>
      {saved && <span className="text-[10px] text-success">✓</span>}
    </div>
  );
}

/** P1：还原确认弹窗（调已有 restore_file）。targets 为空时禁用确认。 */
function RestoreBackupDialog({ entry, onClose }: { entry: BackupFileInfo; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState(entry.targets[0] ?? "");
  const { toast } = useToast();

  const onConfirm = async () => {
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("restore_file", { backup_path: entry.backupPath, target_path: target });
      toast("已还原到操作前版本", "success");
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
          <Icon name="restore" size={18} />
          还原备份
        </h4>
        <div className="mb-3 space-y-1.5 rounded-md bg-muted/30 p-3 text-xs">
          <div className="flex gap-2">
            <span className="w-14 shrink-0 text-muted-foreground">备份</span>
            <code className="break-all font-mono">{entry.backupPath}</code>
          </div>
          <div className="flex gap-2">
            <span className="w-14 shrink-0 text-muted-foreground">大小</span>
            <span className="font-mono">{formatBytes(entry.sizeBytes)}</span>
          </div>
        </div>
        {entry.targets.length > 0 ? (
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              还原到（创建备份时记录的原始路径）
            </label>
            {entry.targets.length === 1 ? (
              <code className="block break-all rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
                {entry.targets[0]}
              </code>
            ) : (
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-card px-2 font-mono text-xs outline-none focus:border-primary"
              >
                {entry.targets.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : (
          <p className="mb-3 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Icon name="info" size={14} className="mt-0.5 shrink-0" />
            未找到还原目标（白名单关闭、该路径已不在白名单内，或这是无索引记录的历史备份），无法安全还原。可在「审计日志」中对应操作的详情里还原。
          </p>
        )}
        {err && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive break-all">
            {err}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={busy || entry.targets.length === 0 || !target}
            isLoading={busy}
            loadingText="还原中…"
          >
            确认还原
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
