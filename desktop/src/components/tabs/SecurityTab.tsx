import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult, RunningCommandInfo, CommandOutput } from "../../lib/types";
import { formatUptime } from "../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { DirectoryBrowser } from "../modals/DirectoryBrowser";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
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
            <div className="s-icon" style={{ background: "linear-gradient(135deg,#6366F1,#4F46E5)" }}>💾</div>
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
            <div className="s-icon" style={{ background: "linear-gradient(135deg,#6366F1,#4F46E5)" }}>📋</div>
            <div className="s-body">
              <div className="s-label">备份保留份数</div>
              <div className="s-row-desc">超出后自动清理最早的备份</div>
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
            <div className="s-icon" style={{ background: "linear-gradient(135deg,#6366F1,#4F46E5)" }}>📁</div>
            <div className="s-body">
              <div className="s-label">备份目录</div>
              <div className="s-row-desc font-mono text-[11px]">{status?.backupDir ?? "未设置"}</div>
            </div>
            <div className="s-right">
              <Button variant="outline" size="sm" onClick={() => setBrowserOpen(true)}>浏览…</Button>
            </div>
          </div>
          <InlineStr
            value={status?.backupDir ?? ""}
            saved={lastSavedField === "backupDir"}
            onSave={(v) => saveField({ backupDir: v }, "backupDir")}
            className="hidden"
          />

          <div className="my-3.5 h-px bg-border" />

          {/* ══ 请求限流 — PastePanda 合并行 ══ */}
          <div className="s-sec-label">请求限流</div>

          <div className="s-row group">
            <div className="s-icon" style={{ background: "linear-gradient(135deg,#F59E0B,#EA580C)" }}>⏱</div>
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
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[80px]">PID</TableHead>
              <TableHead>命令</TableHead>
              <TableHead className="w-[90px]">已运行</TableHead>
              <TableHead className="w-[160px]" />
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
                  <TableCell className="text-xs text-muted-foreground">
                    {formatUptime(cmd.elapsedSeconds)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggle(cmd.handle)}>
                        <Icon name={expanded.has(cmd.handle) ? "chevronUp" : "chevronDown"} size={14} />
                        {expanded.has(cmd.handle) ? "收起" : "查看输出"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
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
                    <TableCell colSpan={4} className="p-0">
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

function InlineStr({
  value: initial, saved, onSave, className = "",
}: {
  value: string; saved: boolean; onSave: (v: string) => Promise<void>; className?: string;
}) {
  const [value, setValue] = useState(initial);
  const initialized = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!initialized.current) { setValue(initial); initialized.current = !!initial; }
  }, [initial]);
  const handleChange = (v: string) => {
    setValue(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSave(v), 800);
  };
  return (
    <div className={className}>
      <Input value={value} onChange={(e) => handleChange(e.target.value)}
        onBlur={() => { if (debounceRef.current) { clearTimeout(debounceRef.current); onSave(value); } }}
      />
      {saved && <span className="text-[10px] text-success">✓</span>}
    </div>
  );
}
