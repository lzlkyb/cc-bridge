import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

interface AuditPagerProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: number) => void;
}

const PAGE_SIZES = [20, 50, 100];

/**
 * 页码窗口：首页 + 当前页 ±1 + 末页 + 省略号。
 * 总页数 ≤7 时全部显示，避免大日志量下页码挤爆。纯函数。
 */
function pageWindow(cur: number, tp: number): (number | "…")[] {
  if (tp <= 7) return Array.from({ length: tp }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  if (cur > 3) out.push("…");
  for (let i = Math.max(2, cur - 1); i <= Math.min(tp - 1, cur + 1); i++) out.push(i);
  if (cur < tp - 2) out.push("…");
  out.push(tp);
  return out;
}

/** 审计日志分页器：每页条数分段 + 首/上/下/末页导航 + 页码窗口（策略 A）。 */
export function AuditPager({ page, pageSize, total, onPageChange, onPageSizeChange }: AuditPagerProps) {
  const tp = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, tp);
  const win = pageWindow(cur, tp);

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-xs text-muted-foreground">
        共 <b className="font-semibold text-foreground">{total.toLocaleString()}</b> 条 · 第{" "}
        <b className="font-semibold text-foreground">{cur}</b> / {tp} 页
        <span className="ml-1 text-muted-foreground/70">（筛选作用于当前页）</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {/* 每页条数分段控件 */}
        <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
          {PAGE_SIZES.map((n) => (
            <button
              key={n}
              onClick={() => onPageSizeChange(n)}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                pageSize === n
                  ? "bg-background text-foreground shadow-card"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        {/* 分页按钮组 */}
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={cur <= 1} onClick={() => onPageChange(1)}>
            « 首页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={cur <= 1}
            onClick={() => onPageChange(cur - 1)}
          >
            <Icon name="arrowUp" size={14} className="-rotate-90" />
            上一页
          </Button>
          <div className="mx-1 flex items-center gap-1">
            {win.map((p, idx) =>
              p === "…" ? (
                <span key={`e${idx}`} className="px-1 text-muted-foreground">
                  …
                </span>
              ) : (
                <Button
                  key={p}
                  variant={p === cur ? "default" : "outline"}
                  size="sm"
                  className="min-w-[34px] px-2"
                  onClick={() => onPageChange(p)}
                >
                  {p}
                </Button>
              )
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={cur >= tp}
            onClick={() => onPageChange(cur + 1)}
          >
            下一页
            <Icon name="arrowUp" size={14} className="rotate-90" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={cur >= tp}
            onClick={() => onPageChange(tp)}
          >
            末页 »
          </Button>
        </div>
      </div>
    </div>
  );
}
