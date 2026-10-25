import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CcToolCall } from "../../lib/ccGuiTypes";
import { computeLineDiff } from "../../lib/ccDiff";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { Icon, type IconName } from "../ui/icon";
import { DiffBlock } from "./DiffBlock";
import {
  TOOL_TEXT_LIMIT,
  asString,
  clampToolText,
  editCount,
  editPair,
  toolArgLabel,
  toolKind,
} from "./summarize";

const KIND_ICON: Record<string, IconName> = {
  edit: "file",
  write: "file",
  bash: "terminal",
  read: "eye",
  other: "sliders",
};

/** 超过这个长度的命令，展开时在输出上方补一份完整原文（行内那一份是截断的）。 */
const CMD_FULL_THRESHOLD = 80;

function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * 等宽输出块：Bash 的 stdout 与「其他工具」的 JSON 兜底共用。
 *
 * 🔴 刻意不用「外框 + 圆角 + 底色」：工具行本身已经没有卡片外壳，再套一个 rounded
 *    border 就是卡中卡。改成左侧 2px 细线 + 极淡底色，照样和普通文字分层，
 *    但不多出一层容器（hermes-webui：If a card contains another card, one of
 *    them is probably unnecessary / Use almost no shadows in the transcript）。
 *
 * `clipped` 时正文是截断版，但**复制仍复制全文** —— 复制本来就是给「想拿完整
 * 输出去别处」的人用的，复制到一半等于没复制。
 */
function MonoBlock({
  text,
  tone = "plain",
  clipped = false,
  copied = false,
  onCopy,
}: {
  text: string;
  tone?: "plain" | "error";
  clipped?: boolean;
  copied?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div className="group/mono relative">
      <pre
        data-cc-inset
        className={`max-h-[168px] overflow-auto whitespace-pre-wrap break-words border-l-2 bg-muted/25 px-2.5 py-1.5 pr-14 font-mono text-[12px] leading-[1.6] ${
          tone === "error"
            ? "border-destructive/50 text-destructive-ink"
            : "border-border text-muted-foreground"
        }`}
      >
        {text}
      </pre>
      {clipped && (
        <p className="px-2.5 pt-1 text-[10.5px] text-muted-foreground">
          内容过长，仅显示前 {TOOL_TEXT_LIMIT / 1000}k 字符（完整内容在会话记录里）
        </p>
      )}
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          title={copied ? "已复制" : "复制全文"}
          aria-label="复制全文"
          aria-live="polite"
          className="absolute right-1.5 top-1.5 flex h-5 items-center gap-1 rounded border border-border bg-card/90 px-1.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/mono:opacity-100"
        >
          <Icon name={copied ? "check" : "copy"} size={10} />
          {copied ? "已复制" : "复制"}
        </button>
      )}
    </div>
  );
}

/**
 * 工具调用行。
 *
 * 🔴 从「卡」改成「行」：hermes-webui 的判据是 tool call 属于 transcript metadata，
 *    必须排在用户/助手正文的视觉优先级之下；aydesign 的模式清单也要求默认卡高
 *    <120px。原来十次调用就是十张带阴影的卡，把正文挤成碎屑。
 *
 * 现在所有工具共用一条 24px 的紧凑行（图标 + 名字 + 参数摘要 + 状态），
 * 展开的内容缩进到图标右侧，形成「摘要 → 详情」的披露结构而不是嵌套容器。
 *
 * Edit/Write 默认展开（diff 是这次调用的意义）；Bash 有输出才默认展开 ——
 * 直播时 `toolUse` 先到（无 result），结果落地那一刻再自动展开一次
 * （用户亲手收起过就不代劳）；Read 与其余折叠（参数已能说明问题）。
 */
function ToolCardImpl({ tool }: { tool: CcToolCall }) {
  const kind = toolKind(tool.name);
  const [open, setOpen] = useState(kind === "edit" || kind === "write" || (kind === "bash" && !!tool.result));
  /** 用户亲手切换过展开态之后，就不再自动展开（那是在替用户做他刚拒绝过的事）。 */
  const touchedRef = useRef(false);
  useEffect(() => {
    if (kind === "bash" && tool.result && !touchedRef.current) setOpen(true);
  }, [kind, tool.result]);
  const toggle = () => {
    touchedRef.current = true;
    setOpen((v) => !v);
  };

  const { copy, isCopied } = useCopyFeedback();
  const pair = useMemo(() => editPair(tool.input), [tool.input]);
  const edits = useMemo(() => (kind === "edit" ? editCount(tool.input) : 1), [kind, tool.input]);
  const diffInfo = useMemo(() => {
    if (kind !== "edit" && kind !== "write") return null;
    const source = kind === "write" ? { oldText: "", newText: asString(tool.input.content) } : pair;
    if (!source) return null;
    const d = computeLineDiff(source.oldText, source.newText);
    return { added: d.added, removed: d.removed, truncated: d.truncated };
  }, [kind, pair, tool.input]);
  /** 输出 / 入参 JSON 的展示级截断（实时链路没有入库那道 16k 闸，见 `clampToolText`）。 */
  const outs = useMemo(() => {
    const cl = (raw: string) => ({ ...clampToolText(raw), raw });
    if (kind === "bash" && tool.result) return { bash: cl(tool.result) };
    if (kind === "read") return { read: cl(JSON.stringify(tool.input, null, 2)) };
    if (kind === "other") return { other: cl(JSON.stringify(tool.input, null, 2)) };
    return {};
  }, [kind, tool.input, tool.result]);

  const argLabel = toolArgLabel(tool.input);
  const command = asString(tool.input.command);
  const hasBody =
    (kind === "edit" && !!pair) ||
    kind === "write" ||
    (kind === "bash" && !!tool.result) ||
    kind === "read" ||
    kind === "other";

  return (
    // data-cc-tool：变更集面板的跳转锚点（CcGuiTab 按 tool.id  querySelector 找它）。
    <div data-cc-tool={tool.id}>
      <button
        type="button"
        data-cc-row
        className="flex w-full items-center gap-2 rounded-md px-2 py-[3px] text-left transition-colors hover:bg-accent/40"
        onClick={() => hasBody && toggle()}
        aria-expanded={hasBody ? open : undefined}
      >
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-primary/10 text-primary">
          <Icon name={KIND_ICON[kind]} size={11} />
        </span>
        <span className="shrink-0 text-[12px] font-semibold text-foreground">{tool.name}</span>
        {/* 命令可能很长：允许收缩并省略尾部，完整原文看 title 或展开态 */}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground" title={argLabel}>
          {argLabel}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[11px]">
          {diffInfo && (diffInfo.added > 0 || diffInfo.removed > 0) && (
            <>
              <span className="text-success-ink">+{diffInfo.added}</span>
              <span className="text-destructive-ink">−{diffInfo.removed}</span>
            </>
          )}
          {diffInfo?.truncated && (
            <span title="diff 中段过大，已降级为整段替换 —— ± 数字与行号是近似值" className="text-muted-foreground">
              ≈
            </span>
          )}
          {tool.status === "running" ? (
            <span className="flex items-center gap-1 text-primary">
              <Icon name="spinner" size={11} className="animate-spin" />
              执行中
            </span>
          ) : tool.status === "error" || tool.isError ? (
            <span className="flex items-center gap-1 text-destructive-ink">
              <Icon name="alert" size={11} />
              失败
            </span>
          ) : (
            <span className="flex items-center gap-1 text-success-ink">
              <Icon name="check" size={11} />
              {formatDuration(tool.durationMs)}
            </span>
          )}
          {hasBody && (
            <Icon
              name="chevronDown"
              size={11}
              className={`text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
            />
          )}
        </span>
      </button>

      {open && hasBody && (
        <div className="pb-1.5 pl-[30px] pr-1">
          {(kind === "edit" || kind === "write") && (
            <>
              {edits > 1 && (
                <p className="mb-1 text-[10.5px] text-muted-foreground">
                  共 {edits} 处修改，diff 按执行顺序拼接（⋯ 行是分隔）
                </p>
              )}
              <DiffBlock
                oldText={kind === "write" ? "" : (pair?.oldText ?? "")}
                newText={kind === "write" ? asString(tool.input.content) : (pair?.newText ?? "")}
              />
            </>
          )}
          {kind === "bash" && outs.bash && (
            <div className="flex flex-col gap-1.5">
              {command.length > CMD_FULL_THRESHOLD && (
                <p className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6] text-foreground">
                  {command}
                </p>
              )}
              <MonoBlock
                text={outs.bash.text}
                clipped={outs.bash.clipped}
                tone={tool.isError ? "error" : "plain"}
                copied={isCopied(tool.id)}
                onCopy={() => copy(tool.id, outs.bash!.raw)}
              />
            </div>
          )}
          {kind === "read" && outs.read && (
            <MonoBlock
              text={outs.read.text}
              clipped={outs.read.clipped}
              tone={tool.isError ? "error" : "plain"}
              copied={isCopied(`${tool.id}:in`)}
              onCopy={() => copy(`${tool.id}:in`, outs.read!.raw)}
            />
          )}
          {kind === "other" && outs.other && (
            <MonoBlock
              text={outs.other.text}
              clipped={outs.other.clipped}
              copied={isCopied(`${tool.id}:in`)}
              onCopy={() => copy(`${tool.id}:in`, outs.other!.raw)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export const ToolCard = memo(ToolCardImpl);
