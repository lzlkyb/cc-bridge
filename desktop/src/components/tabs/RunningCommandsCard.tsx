import { useState, useEffect, useRef, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { RunningCommandInfo, CommandOutput } from "../../lib/types";
import { formatUptime } from "../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Badge } from "../ui/badge";

/**
 * 运行中的后台命令（run_command(background=true) 启动）。与远程的
 * get_command_output 读取同一份注册表，让本机面板也能看到并一键终止。
 * 无后台命令时不渲染，避免空卡片占地。
 * danger：命令执行已开启时整卡高亮红边 + 提醒，引导用户确认进程可信。
 */
export function RunningCommandsCard({ danger = false }: { danger?: boolean }) {
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
          已结束的命令会保留一段时间供查看输出（看右侧“状态”区分是否还在跑），之后自动清理。
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
                <TableRow
                  className={`${i % 2 === 0 ? "bg-muted/20" : ""} cursor-pointer`}
                  onClick={() => toggle(cmd.handle)}
                  title="点击整行任意位置展开/收起输出"
                >
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
                      <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={(e) => { e.stopPropagation(); toggle(cmd.handle); }}>
                        <Icon name={expanded.has(cmd.handle) ? "chevronUp" : "chevronDown"} size={14} />
                        {expanded.has(cmd.handle) ? "收起" : "查看输出"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="whitespace-nowrap text-destructive hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); stop(cmd.handle); }}
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
 * 避免用户把处于清理宽限期内的已结束命令误以为还在运行。
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
