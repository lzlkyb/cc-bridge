interface Props {
  lineEnding: string;
  lineCount: number;
  size: number;
  dirty: boolean;
  conflict: boolean;
  readOnly: boolean;
  /** 远端 mtime（Unix 秒），0 表示未知。 */
  remoteMtime: number;
  /** 连接展示名（`user@host`）。 */
  endpoint: string;
  loading: boolean;
}

/** 人类可读字节数。 */
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(s: number): string {
  if (!s) return "—";
  try {
    return new Date(s * 1000).toLocaleTimeString();
  } catch {
    return "—";
  }
}

/**
 * 编辑器状态栏：编码 / 换行 / 行数 / 大小 + 保存态，右侧是远端时间与连接。
 * 四态互斥显示（已保存 / 未保存 / 未保存·远端已变更 / 只读），
 * 避免同时出现两个矛盾的状态标签。
 */
export function SshFileEditorStatus({
  lineEnding,
  lineCount,
  size,
  dirty,
  conflict,
  readOnly,
  remoteMtime,
  endpoint,
  loading,
}: Props) {
  const state = loading
    ? { text: "正在读取…", cls: "text-muted-foreground" }
    : readOnly
      ? { text: "只读", cls: "text-amber-600 dark:text-amber-400" }
      : conflict
        ? { text: "● 未保存 · 远端已变更", cls: "text-amber-600 dark:text-amber-400" }
        : dirty
          ? { text: "● 未保存", cls: "text-amber-600 dark:text-amber-400" }
          : { text: "✓ 已保存", cls: "text-emerald-600 dark:text-emerald-400" };
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
      <span>UTF-8</span>
      <span>{lineEnding === "crlf" ? "CRLF" : "LF"}</span>
      <span>{lineCount} 行</span>
      <span>{fmtSize(size)}</span>
      <span className={state.cls}>{state.text}</span>
      <span className="ml-auto flex items-center gap-3">
        <span>远端 {fmtTime(remoteMtime)}</span>
        <span className="truncate" title={endpoint}>
          {endpoint}
        </span>
      </span>
    </div>
  );
}
