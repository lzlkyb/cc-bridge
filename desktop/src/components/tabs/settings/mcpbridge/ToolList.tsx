import { useState } from "react";
import type { McpTool } from "./types";

/** 超过这个数就折叠。纯展示取舍：列表里一口气铺 20 行会把其它行顶出视口。 */
const FOLD_AT = 8;
/** instructions 截断阈值（字符）。codegraph 那段有两千多字。 */
const INSTR_CLAMP = 140;

/**
 * 工具清单。**四处共用同一个**：导入向导候选行、设置页服务行、
 * 启用风险确认框、以及探测后的展开区。
 *
 * 为什么以工具清单为主而不是 `instructions`：后者是 MCP 的**可选**字段，
 * 很多 server 压根不提供；而工具描述是必填项。只靠 `instructions` 的话，
 * 一半的 server 点完还是一片空白。
 */
export function ToolList({
  tools,
  instructions,
  title,
}: {
  tools: McpTool[];
  instructions?: string;
  /** 顶部那行小字。不传则不渲染标题行。 */
  title?: string;
}) {
  const [all, setAll] = useState(false);
  const [fullInstr, setFullInstr] = useState(false);

  if (!tools.length && !instructions) return null;

  const shown = all ? tools : tools.slice(0, FOLD_AT);
  const rest = tools.length - shown.length;
  const longInstr = !!instructions && instructions.length > INSTR_CLAMP;

  return (
    <div className="mt-2 border-t border-dashed pt-2">
      {title && <div className="mb-1.5 text-[11px] text-muted-foreground">{title}</div>}

      {instructions && (
        <div className="mb-2 rounded-md bg-accent px-2 py-1.5 text-[11.5px] leading-relaxed text-accent-foreground">
          {fullInstr || !longInstr ? instructions : `${instructions.slice(0, INSTR_CLAMP)}…`}
          {longInstr && (
            <button
              type="button"
              className="ml-1.5 text-[11px] underline"
              onClick={() => setFullInstr((v) => !v)}
            >
              {fullInstr ? "收起" : "展开全文"}
            </button>
          )}
        </div>
      )}

      {shown.map((t) => (
        <div key={t.name} className="flex gap-2.5 py-0.5 text-[11.5px]">
          {/* 定宽：名字列对齐才扫得快；太长的名字宁可溢出也不拆行。 */}
          <code className="w-[148px] shrink-0 truncate font-mono text-[11px]">{t.name}</code>
          <span className="min-w-0 text-muted-foreground">{t.summary}</span>
        </div>
      ))}

      {rest > 0 && (
        <button
          type="button"
          className="pt-1 text-[11px] text-primary"
          onClick={() => setAll(true)}
        >
          …另 {rest} 个
        </button>
      )}
    </div>
  );
}
