import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import {
  formatCmdDuration,
  navBlockAt,
  navBlockCount,
  navBlockOutput,
  type CmdBlock,
} from "../../lib/terminalCommandNav";
import { bufferToText, downloadText, exportFileName } from "../../lib/terminalExport";

interface Props {
  /** 活动会话的终端。面板跟着**活动标签**走（切换标签即换数据）。 */
  termRef: MutableRefObject<Terminal | null>;
  /** 连接名，导出文件名用。 */
  name: string;
  /** 会话已断开：仍可查看与导出（读的是本地缓冲区），仅在文案上提示。 */
  closed: boolean;
  onClose: () => void;
}

/** 面板一行 = 块元数据 + 输出首行预览。列表不持有完整输出（可能要几 MB）。 */
interface Row extends CmdBlock {
  index: number;
  preview: string;
}

/** 按 lib 层当前的块列表重建面板数据，**最新的一条在最上面**。 */
function snapshot(term: Terminal | null): Row[] {
  if (!term) return [];
  const total = navBlockCount(term);
  const rows: Row[] = [];
  for (let i = 0; i < total; i++) {
    const block = navBlockAt(term, i);
    if (!block) continue;
    const output = navBlockOutput(term, i) ?? "";
    // 预览取**第一个非空行**：很多命令输出的第一行是空的（换行、清屏序列残留），
    // 直接取首行等于什么都没显示。
    const preview = output.split("\n").find((l) => l.trim() !== "") ?? "";
    rows.push({ ...block, index: i, preview });
  }
  return rows.reverse();
}

/**
 * 命令历史面板：右侧滑出浮层（宽 308px），每条命令一行。
 *
 * 🔴 必须是 `absolute` 覆盖层，**不能占一行布局**：占布局会改终端容器高度 →
 * 触发 fit → 把新的 rows 发给远端 PTY，等于「打开一个只读面板」把远端 TUI 重排一次
 * （与 `SshTerminalFind.tsx` 是同一个坑）。
 *
 * 数据来自 OSC 133 钩子（`lib/terminalCommandNav.ts`）。⚠️ **Claude Code 这类全屏 TUI
 * 里没有 shell 提示符**，因此没有 A/D 事件、面板永远是空的——空态必须说清楚，
 * 否则用户会以为功能坏了。
 */
export function SshCommandBlocksPanel({ termRef, name, closed, onClose }: Props) {
  const [rows, setRows] = useState<Row[]>(() => snapshot(termRef.current));
  // 上次快照时的块数：用它当「有没有新命令」的哨兵，避免每 700ms 都重建一次数组。
  const countRef = useRef(rows.length);

  // 块在 lib 层累积（不是 React state），只能轮询它的长度。轮询本身很轻（读数组
  // length），只有真的变了才做快照。
  useEffect(() => {
    const id = setInterval(() => {
      const term = termRef.current;
      if (!term) return;
      const n = navBlockCount(term);
      if (n === countRef.current) return;
      countRef.current = n;
      setRows(snapshot(term));
    }, 700);
    return () => clearInterval(id);
  }, [termRef]);

  const jump = useCallback(
    (line: number) => {
      const term = termRef.current;
      if (!term) return;
      term.scrollToLine(line);
      term.focus();
    },
    [termRef],
  );

  const copyOutput = useCallback(
    (index: number) => {
      const term = termRef.current;
      const text = term ? (navBlockOutput(term, index) ?? "") : "";
      if (!text.trim()) {
        toast("这条命令没有输出", "info");
        return;
      }
      navigator.clipboard
        .writeText(text)
        .then(() => toast("已复制该命令的输出", "success"))
        .catch(() => toast("复制失败", "error"));
    },
    [termRef],
  );

  const exportAll = useCallback(() => {
    const term = termRef.current;
    const text = term ? bufferToText(term.buffer.active) : "";
    if (!text.trim()) {
      toast("终端没有可导出的内容", "info");
      return;
    }
    downloadText(exportFileName(name), text);
    toast(`已导出 ${text.split("\n").length} 行`, "success");
  }, [termRef, name]);

  return (
    // 🔴 z 只给 5，不能更高：文件浏览器是 `absolute inset-0 z-10`，它和本面板同处一个
    // 层叠上下文（中间没有建上下文的祖先），z 高过 10 就会浮在文件面板上面——
    // 那样面板会显示"文件浏览器看不到的终端"的数据，纯属错乱。终端内容本身没有 z-index，
    // 5 足够盖住它。
    <div className="animate-scale-in absolute inset-y-0 right-0 z-[5] flex w-[308px] flex-col border-l border-border bg-card shadow-lg">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="history" size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium">命令历史</span>
        <span className="rounded bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
          {rows.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {rows.length === 0 ? <EmptyHint closed={closed} /> : rows.map((r) => (
          <BlockRow key={`${r.index}:${r.line}`} row={r} onJump={jump} onCopy={copyOutput} />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-2.5 py-2">
        <button
          type="button"
          onClick={exportAll}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] text-foreground transition-colors hover:bg-muted"
        >
          <Icon name="download" size={12} />
          导出全部为 .txt
        </button>
        <span className="ml-auto text-[10.5px] text-muted-foreground">最多保留 50 条</span>
      </div>
    </div>
  );
}

/** 空态。把「TUI 里没有提示符」这条限制写在面板里，而不是藏在文档里。 */
function EmptyHint({ closed }: { closed: boolean }) {
  return (
    <div className="px-2.5 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
      <p>还没有记录到命令。</p>
      <p className="mt-1.5">
        这个面板靠 shell 提示符钩子（OSC 133）标记每条命令的边界，只有
        <b className="text-foreground"> 普通 shell 会话 </b>
        才有；Claude Code 这类全屏 TUI 没有提示符，因此不会有记录。
      </p>
      {closed && <p className="mt-1.5">会话已断开，这里显示的是断开前的记录。</p>}
    </div>
  );
}

/** 退出码徽标：0 绿 / 非 0 红 / 未知（还在跑或远端没回执）灰。 */
function ExitBadge({ code }: { code: number | null }) {
  if (code === null) {
    return (
      <span
        title="还在执行，或远端没有回执"
        className="flex h-4 w-6 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10px] text-muted-foreground"
      >
        …
      </span>
    );
  }
  const ok = code === 0;
  return (
    <span
      title={`退出码 ${code}`}
      className={`flex h-4 w-6 shrink-0 items-center justify-center rounded font-mono text-[10px] ${
        ok
          ? "bg-green-500/15 text-green-600 dark:text-green-400"
          : "bg-destructive/15 text-destructive-ink"
      }`}
    >
      {code}
    </span>
  );
}

function BlockRow({
  row,
  onJump,
  onCopy,
}: {
  row: Row;
  onJump: (line: number) => void;
  onCopy: (index: number) => void;
}) {
  const dur = formatCmdDuration(row.durMs);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onJump(row.line)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onJump(row.line);
        }
      }}
      title={`跳到这一条（缓冲区第 ${row.line + 1} 行）`}
      className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
    >
      <ExitBadge code={row.exitCode} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">
        {row.preview || <span className="text-muted-foreground">（无输出）</span>}
      </span>
      {dur && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{dur}</span>}
      <button
        type="button"
        title="复制这条命令的输出"
        onClick={(e) => {
          e.stopPropagation();
          onCopy(row.index);
        }}
        className="hidden shrink-0 rounded px-1 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary group-hover:block"
      >
        复制
      </button>
    </div>
  );
}
