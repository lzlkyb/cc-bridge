import { useState } from "react";
import type { McpTool } from "./types";

/**
 * 工具级暴露编辑器（ServerRow 展开区一节）。
 *
 * 交互范式：每次勾选**立即落库**（mcp_bridge_set_allowed_tools），不做草稿态——
 * 与同卡 set_enabled / set_remote_cwd 一致，且这里绝大多数操作是「收紧」，
 * 弹确认框只会让人无脑点掉（R17：安全靠审计与即时生效，不靠摩擦）。
 *
 * 语义对齐后端：`allowedTools` 空 = 全暴露。UI 上显式给出「全选 = 全暴露」的
 * 换算，避免用户以为「清空」等于「全不可用」。
 *
 * 陈旧项（配置里存了、但当前探测清单里没有的名字——server 升级后工具改名）：
 * 单独列在底部灰显 + 提示，可一键移除；不静默丢弃（用户配的是意图，不是垃圾）。
 */
export function ToolFilterEditor({
  tools,
  allowed,
  disabled,
  busy,
  onSave,
}: {
  tools: McpTool[];
  /** 当前配置的清单。空 = 全暴露。 */
  allowed: string[];
  disabled: boolean;
  busy: boolean;
  onSave: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const fullExposure = allowed.length === 0;
  const allowedSet = new Set(allowed);
  // 陈旧项：配置里有、清单里没有。
  const known = new Set(tools.map((t) => t.name));
  const stale = allowed.filter((n) => !known.has(n));
  // 复选框组的选中数：全暴露时视为「全部选中」。
  const selectedCount = fullExposure ? tools.length : allowed.filter((n) => known.has(n)).length;
  const shown = tools.filter(t => `${t.name} ${t.summary}`.toLowerCase().includes(query.trim().toLowerCase()));

  const toggle = (name: string) => {
    // 空清单在后端表示全部开放，不能用取消最后一项来表达关闭全部。
    if ((fullExposure && tools.length <= 1) || (!fullExposure && allowed.length === 1 && allowedSet.has(name))) return;
    if (fullExposure) {
      // 从「全暴露」收窄：第一次取消勾选 = 允许清单变为「其余全部」。
      onSave(tools.filter((t) => t.name !== name).map((t) => t.name));
    } else {
      const next = allowedSet.has(name)
        ? allowed.filter((n) => n !== name)
        : [...allowed, name];
      // 全勾上等价于清空清单（回到全暴露语义），别留一份冗余存档。
      // 🔴 只比对**现存**工具（排除陈旧项）：清单里存着升级前的旧名时，
      // next.length 会永远多出陈旧项数量，用原始长度比对会漏掉换算，
      // 反向更糟——陈旧项恰好凑数时会把「部分暴露」误判成「全暴露」。
      const knownCount = next.filter((n) => known.has(n)).length;
      onSave(knownCount === tools.length ? [] : next);
    }
  };

  return (
    <div className="mcp-tool-filter mt-2 border-t pt-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-foreground">允许远程调用的工具</span>
        <span className="text-xs text-muted-foreground" role="status">
          {fullExposure ? `全部开放 · ${tools.length} 个` : `已选 ${selectedCount} / ${tools.length}`}
        </span>
        <button
          type="button"
          className="ml-auto min-h-8 rounded px-2 text-xs text-primary transition-colors hover:bg-muted disabled:opacity-50"
          disabled={disabled || busy || fullExposure}
          onClick={() => onSave([])}
          title="清空允许清单 = 恢复全部暴露（逃生门：server 升级改了工具名后，用它一键回到全暴露）"
        >
          恢复全部暴露
        </button>
      </div>
      {tools.length > 8 && (
        <input type="search" aria-label="搜索工具名称或说明" placeholder="搜索工具名称或说明…" value={query} onChange={e => setQuery(e.target.value)} className="mb-2 w-full rounded-md border bg-background px-3 py-2 text-sm" />
      )}

      {tools.length === 0 ? (
        <p className="py-1 text-[11px] text-muted-foreground">
          还没有工具清单——先点「探测」让 cc-bridge 启动它一次，才能在这里逐个勾选。
        </p>
      ) : (
        <div className="mcp-tool-options" role="group" aria-label="允许远程调用的工具">
          {shown.map((t) => {
            const checked = fullExposure || allowedSet.has(t.name);
            const lastSelected = checked && (fullExposure ? tools.length === 1 : allowed.length === 1);
            return (
              <label
                key={t.name}
                className="mcp-tool-option flex cursor-pointer items-start gap-3 rounded-md px-2 py-2.5 text-xs transition-colors hover:bg-muted/60"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  checked={checked}
                  disabled={disabled || busy || lastSelected}
                  onChange={() => toggle(t.name)}
                  aria-label={`暴露工具 ${t.name}`}
                />
                <span className="min-w-0 break-words">
                  <code className="block break-all font-mono text-xs font-medium">{t.name}</code>
                  <span className="mt-1 block leading-relaxed text-muted-foreground">{t.summary}</span>
                </span>
              </label>
            );
          })}
          {!shown.length && <p role="status" className="py-3 text-sm text-muted-foreground">没有匹配的工具，请更换关键词。</p>}
        </div>
      )}

      {stale.length > 0 && (
        <div className="mt-1.5 rounded-md bg-muted/60 px-2 py-1.5">
          <div className="mb-1 text-[10.5px] font-semibold text-muted-foreground">
            以下工具在当前清单里已不存在（server 升级后可能改名），不再暴露：
          </div>
          {stale.map((n) => (
            <div key={n} className="flex items-center gap-2 py-0.5 text-[11px]">
              <code className="font-mono text-muted-foreground line-through">{n}</code>
              <button
                type="button"
                disabled={disabled || busy || allowed.length === 1}
                className="ml-auto rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-40"
                onClick={() => onSave(allowed.filter((x) => x !== n))}
                title={allowed.length === 1 ? "移除最后一项会恢复全部开放，请明确选择「恢复全部暴露」" : "从允许清单移除这条陈旧项"}
                aria-label={`移除陈旧工具 ${n}`}
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        勾选即时生效：未勾选的工具对远程不可见、调用会被服务端拒绝并留痕日志页。
        如需关闭全部工具，请停用该服务；空允许清单代表全部开放，因此不能取消最后一项。
      </p>
    </div>
  );
}
