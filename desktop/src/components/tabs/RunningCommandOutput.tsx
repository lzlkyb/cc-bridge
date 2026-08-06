import { useState, useEffect, useRef } from "react";
import { invoke } from "../../lib/tauri";
import type { CommandOutput } from "../../lib/types";
import { copyText } from "../../lib/utils";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { useAppHidden } from "../../lib/appVisibility";

/**
 * 展开区顶部的完整命令行。
 *
 * **为何需要它**：列表里的命令列在 `table-fixed` 下会被省略号截断，而 hover tooltip
 * 对超长命令既难读又**无法选中复制**。排查问题时「看全 / 复制这条命令」是明确动作，
 * 放在本来就要点开的展开区最自然。命令再短也照常渲染，不做条件隐藏——位置固定才好找。
 */
function FullCommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  // 与应用内其它复制按钮一致：失败要报错，避免“显示已复制但其实没复制”的假阳性反馈。
  const copy = () =>
    void copyText(
      command,
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );

  return (
    <div className="flex items-start gap-2 rounded-md border bg-card p-2.5">
      <span className="w-12 shrink-0 pt-0.5 text-[10px] text-muted-foreground">完整命令</span>
      {/* min-w-0 必须有：flex 子项默认 min-width:auto，不置 0 就会被长命令的 min-content
          宽度撑破容器——跟表格那个溢出是同一个坑。 */}
      <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
        {command}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 whitespace-nowrap"
        onClick={copy}
        title="复制完整命令"
      >
        <Icon name={copied ? "check" : "copy"} size={13} />
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

/**
 * 单条后台命令的实时输出面板。
 * 点「查看输出」展开时挂载：每 3s 增量拉取 get_command_output，按 stdoutOffset /
 * stderrOffset 追加（ref 保存 offset，effect 仅在 handle 或可见性变化时重建），
 * 避免大文本反复重渲。命令结束后停止轮询，历史输出仍可查看，方便事后排查。
 */
export function CommandOutputPanel({
  handle,
  command,
}: {
  handle: string;
  command: string;
}) {
  const appHidden = useAppHidden();
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
    // 窗口不可见时不轮询；offset 存在 ref 里，恢复可见后 effect 重跑会立即 poll 一次
    // 拿增量，不会丢输出也不会重复追加。
    if (appHidden) return;
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
    timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [handle, appHidden]);

  return (
    <div className="space-y-3 p-3">
      <FullCommandRow command={command} />
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
        <span className="text-[11px] text-muted-foreground">实时输出（3s 刷新）</span>
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
      <div className="flex items-center justify-between text-[11px] text-muted-foreground term-meta">
        <span>
          {label} · {bytes.toLocaleString()} 字节
        </span>
        {truncated && <span className="text-warning">已截断</span>}
      </div>
      <pre
        ref={ref}
        className={`termbox max-h-[200px] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-[#0d1117] p-2.5 font-mono text-[11px] leading-relaxed ${
          isError ? "text-destructive" : "text-[#d4d4d4]"
        }`}
      >
        {text ? (isError ? <span className="e">{text}</span> : text) : <span className="opacity-40">（暂无输出）</span>}
      </pre>
    </div>
  );
}
