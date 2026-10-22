import { Fragment } from "react";
import type { AuditEntry } from "../../lib/types";
import { toolLabel, formatDurationMs } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Icon } from "../ui/icon";
import { TableRow, TableCell } from "../ui/table";
import { DetailPanel } from "./LogDetailPanel";
import { summarizeParams } from "../../lib/logFormat";

interface LogRowProps {
  entry: AuditEntry;
  /** 行号（斑马纹用）。 */
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onViewDiff: (entry: AuditEntry) => void;
  onRestore: (entry: AuditEntry) => void;
}

/**
 * 单条审计行 + 其展开详情行（a11y 键盘化）。
 *
 * 原来「整行只能鼠标点开」——无 tabIndex/role/键盘事件，键盘用户与读屏用户
 * 根本到不了「查看变更 / 一键还原」（impeccable critique P1）。现在：
 * - 行是可聚焦元素：`tabIndex=0` + `role="button"` + `aria-expanded`，
 *   Enter / Space 切换展开（Space preventDefault 防页面滚动）；
 * - 焦点环只在 focus-visible（键盘聚焦）时出现，鼠标点击不显示；
 * - 行尾 30px 展开钮：发现性入口（鼠标用户不必猜「这行能点」），
 *   点击 stopPropagation 防止与行的 onClick 双触发。
 *
 * 为什么从 LogTab 拆出来：行 + 详情两个 TableRow 的 JSX 约 50 行，抽走后
 * LogTab 才能落回体量上限内（棘轮 487 只许变小）。
 */
export function LogRow({ entry, index, expanded, onToggle, onViewDiff, onRestore }: LogRowProps) {
  return (
    <Fragment>
      <TableRow
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault(); // Space 默认滚页面，必须拦
            onToggle();
          }
        }}
        onClick={onToggle}
        className={`cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
          entry.success
            ? index % 2 === 0
              ? "bg-muted/20"
              : ""
            : "bg-destructive/5 log-err"
        }`}
      >
        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
          {new Date(entry.timestamp).toLocaleTimeString()}
        </TableCell>
        <TableCell>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium">{toolLabel(entry.tool)}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{entry.tool}</span>
          </div>
        </TableCell>
        <TableCell className="truncate text-xs text-muted-foreground">
          {summarizeParams(entry.params)}
        </TableCell>
        <TableCell className="truncate font-mono text-xs text-muted-foreground">
          {entry.sourceIp ?? "—"}
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          {entry.durationMs != null ? formatDurationMs(entry.durationMs) : "—"}
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <Badge variant={entry.success ? "success" : "destructive"}>
            {entry.success ? "成功" : "失败"}
          </Badge>
        </TableCell>
        <TableCell className="w-9 whitespace-nowrap text-right">
          <button
            type="button"
            aria-label="详情"
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="grid h-[30px] w-[30px] place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon
              name="chevronDown"
              size={16}
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/30">
            <DetailPanel entry={entry} onViewDiff={onViewDiff} onRestore={onRestore} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
