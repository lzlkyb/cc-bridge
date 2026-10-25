import { memo } from "react";
import type { CcToolCall } from "../../lib/ccGuiTypes";
import { Icon } from "../ui/icon";
import { todoItems, type TodoItem } from "./summarize";

/**
 * TodoWrite 的「任务计划」进度卡（设计稿《对话页-Markdown与TodoWrite卡片》B 期）。
 *
 * 纯展示组件：TodoWrite 每次调用都是全量列表，`MessageList` 只把**最新一次**
 * 交给本卡、旧的折叠成一行 —— 不折叠的话一次多步重构就是七八张几乎一样的卡刷屏。
 * 列表区上限 148px 内滚动：它是进行时态的仪表，不是完整清单页。
 *
 * `in_progress` 项呼吸点高亮；全部完成时头部图标 / 计数 / 进度条转 success。
 */
function TodoProgressCardImpl({ tool }: { tool: CcToolCall }) {
  const items = todoItems(tool.input);
  if (!items) return null;
  const done = items.filter((i) => i.status === "completed").length;
  const allDone = done === items.length;

  return (
    // data-cc-tool：审批审计面板的跳转锚点（与 ToolCard 同一口径）。
    <div data-cc-tool={tool.id} className="max-w-[560px] overflow-hidden rounded-[10px] border border-border bg-card/35">
      <div className="flex h-[30px] items-center gap-2 border-b border-border/80 px-2.5">
        <Icon name="check" size={12} className={allDone ? "text-success-ink" : "text-primary"} />
        <span className="text-[11.5px] font-semibold tracking-[0.02em]">任务计划</span>
        <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">
          {allDone ? `${done} / ${items.length} · 全部完成` : `${done} / ${items.length}`}
        </span>
        <span className="relative h-0.5 w-16 overflow-hidden rounded-full bg-muted">
          <span
            className={`absolute inset-y-0 left-0 rounded-full transition-[width] ${allDone ? "bg-success" : "bg-primary"}`}
            style={{ width: `${(done / items.length) * 100}%` }}
          />
        </span>
      </div>
      <ul className="max-h-[148px] list-none overflow-y-auto p-1.5">
        {items.map((item, i) => (
          <TodoRow key={`${i}:${item.content}`} item={item} />
        ))}
      </ul>
    </div>
  );
}

function TodoRow({ item }: { item: TodoItem }) {
  return (
    <li
      className={`grid min-h-6 grid-cols-[16px_1fr] items-start gap-2 rounded-md px-1.5 py-[3px] text-[12px] leading-[1.5] ${
        item.status === "in_progress" ? "bg-primary/[0.07]" : ""
      }`}
    >
      <span
        className={`mt-[3px] grid h-[13px] w-[13px] place-items-center rounded-[4px] border ${
          item.status === "completed"
            ? "border-success/50 bg-success/15 text-success-ink"
            : item.status === "in_progress"
              ? "border-primary/60 text-primary"
              : "border-border"
        }`}
      >
        {item.status === "completed" ? (
          <Icon name="check" size={9} />
        ) : item.status === "in_progress" ? (
          <span className="h-[5px] w-[5px] animate-pulse rounded-full bg-primary" />
        ) : null}
      </span>
      <span
        className={
          item.status === "completed"
            ? "text-muted-foreground line-through decoration-border"
            : item.status === "in_progress"
              ? "font-medium text-foreground"
              : "text-muted-foreground"
        }
      >
        {item.content}
      </span>
    </li>
  );
}

export const TodoProgressCard = memo(TodoProgressCardImpl);
