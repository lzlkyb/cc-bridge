import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import type { SshSessionRef } from "./TerminalConnectionItem";
import { getTerminal, listTerminals } from "../../lib/terminalRegistry";
import {
  MAX_HITS,
  searchAll,
  type GlobalHit,
  type SearchSource,
} from "../../lib/terminalGlobalSearch";

interface Props {
  /** 全部会话（拿 sessionId → 连接名，用于结果里标「是哪台机器」）。 */
  sessions: SshSessionRef[];
  /** 与标签栏同一个激活回调（TerminalTab 的 openSession：切标签 + 清未读铃 + 关文件面板）。 */
  onActivate: (sessionId: string) => void;
  onClose: () => void;
}

/** 输入到出结果之间的静默时长。一次全扫是「行数 × 会话数」次 translateToString，边敲边扫会卡。 */
const DEBOUNCE_MS = 150;

/**
 * 跨标签搜索：一次搜所有会话的缓冲区。
 *
 * 形态是**居中模态**（不是终端右上角那条搜索框）：它是全局操作——结果横跨多个会话、
 * 点一下还会切标签，做成贴着某个终端的小浮层会让人以为「只搜这一个标签」。
 *
 * 终端实例从 `lib/terminalRegistry.ts` 取（所有会话常驻挂载，后台标签的实例是活的）。
 * 搜索实现见 `lib/terminalGlobalSearch.ts`——不走 SearchAddon，它只能搜单个实例。
 */
export function TerminalGlobalSearch({ sessions, onActivate, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<GlobalHit[]>([]);
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query) {
      setHits([]);
      setScanning(false);
      return;
    }
    setScanning(true);
    const t = setTimeout(() => {
      const sources: SearchSource[] = listTerminals().map(({ sessionId, term }) => ({
        sessionId,
        buffer: term.buffer.active,
      }));
      setHits(searchAll(sources, query, { caseSensitive, regex }));
      setScanning(false);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, caseSensitive, regex]);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) m.set(s.sessionId, s.conn.name || s.conn.host);
    return m;
  }, [sessions]);

  /** 跳到命中：先切标签（数据在后台都在，但用户要看），再滚到那一行。 */
  const goto = (hit: GlobalHit) => {
    onActivate(hit.sessionId);
    const term = getTerminal(hit.sessionId);
    if (!term) return;
    term.scrollToLine(hit.line);
    term.focus();
  };

  const count = !query ? "" : hits.length === 0 ? "无结果" : hits.length >= MAX_HITS ? `前 ${MAX_HITS} 条` : `${hits.length} 条`;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/25" onClick={onClose} />
      <div className="fixed left-1/2 top-[12vh] z-50 flex max-h-[70vh] w-[620px] max-w-[calc(100vw-48px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Icon name="search" size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索所有标签的终端内容"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // 焦点在本输入框，Esc 不会发给远端（终端没聚焦）。
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
          />
          <span className="min-w-0 shrink-0 text-[10.5px] text-muted-foreground">
            {scanning ? "扫描中…" : count}
          </span>
          <ToggleBtn title="区分大小写" active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>
            <span className="text-[11px] font-semibold leading-none">Aa</span>
          </ToggleBtn>
          <ToggleBtn title="正则表达式" active={regex} onClick={() => setRegex((v) => !v)}>
            <span className="font-mono text-[11px] leading-none">.*</span>
          </ToggleBtn>
          <ToggleBtn title="关闭（Esc）" onClick={onClose}>
            <Icon name="close" size={12} />
          </ToggleBtn>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {!query ? (
            <p className="px-2.5 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
              输入关键词，一次搜过所有已打开的会话（含已断开标签的历史输出）。
            </p>
          ) : hits.length === 0 ? (
            <p className="px-2.5 py-3 text-[11.5px] text-muted-foreground">
              {scanning ? "正在扫描…" : "没有匹配的行。"}
            </p>
          ) : (
            hits.map((h) => (
              <button
                key={`${h.sessionId}:${h.line}`}
                type="button"
                onClick={() => goto(h)}
                title={`跳到 ${nameOf.get(h.sessionId) ?? h.sessionId} 第 ${h.line + 1} 行`}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
              >
                <span className="shrink-0 max-w-28 truncate rounded bg-muted px-1.5 py-px text-[10.5px] text-muted-foreground">
                  {nameOf.get(h.sessionId) ?? "(已关闭)"}
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">
                  {h.line + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">
                  <HitText text={h.text} query={query} caseSensitive={caseSensitive} />
                </span>
              </button>
            ))
          )}
        </div>

        <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10.5px] text-muted-foreground">
          覆盖全部 {sessions.length} 个标签的滚动历史；点结果切到该标签并跳到那一行。
        </div>
      </div>
    </>
  );
}

/**
 * 命中高亮 + 上下文窗口。
 *
 * 行很长时（nginx 日志动辄几百字符）只靠 CSS truncate 会把命中挤到可视区之外，
 * 所以以命中位置为中心裁一个窗口出来；前缀/后缀用 `…` 表示被截断。
 * 正则模式下找不到字面位置（如 `\d+`），此时不做高亮，交给 truncate。
 */
function HitText({ text, query, caseSensitive }: { text: string; query: string; caseSensitive: boolean }) {
  const at = caseSensitive
    ? text.indexOf(query)
    : text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  const from = Math.max(0, at - 40);
  const to = Math.min(text.length, at + query.length + 90);
  return (
    <>
      {from > 0 && "…"}
      {text.slice(from, at)}
      <mark className="bg-primary/25 text-foreground">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length, to)}
      {to < text.length && "…"}
    </>
  );
}

function ToggleBtn({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted ${
        active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
