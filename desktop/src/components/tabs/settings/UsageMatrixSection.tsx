import { useLayoutEffect, useMemo, useRef } from "react";
import type { TokenUsageReport } from "../../../lib/types";
import { buildMatrix, buildUsageCsv, fmtWan } from "../../../lib/usageMath";
import { toolLabel } from "../../../lib/utils";
import { Icon } from "../../ui/icon";
import { useToast } from "../../ui/toast";

/** 矩阵可选时间范围（天）。90 是取数上限（后端 clamp 1..=120）内的长窗档。 */
const RANGES = [7, 30, 90] as const;

/**
 * 「按天 × 工具」矩阵视图（TokenUsageGroup 的第二维度，批D）。
 *
 * 行 = 工具（按合计降序，与排行同口径但**全集**——排行只留 Top10），
 * 列 = 日期（旧→新，与所选范围查询窗口一致），格底色深浅 = 格值 / 全表最大。
 * 横向可滚：90 天 × 24px 塞不下视口，第一列 sticky 保证滚动了也知道看的是哪行。
 *
 * 时间范围独立于概览的 90 天长窗（默认 30 天，对齐审计保留期）：明细表的
 * 用户心智是「最近我用了多少」，铺保留期外的零列没有信息量。
 *
 * 空态分层：本组件只处理「所选范围内无数据」（整卡空态在父组件按 90 天判定）——
 * 更早有调用、范围内没有时，给一键放宽到 90 天的出口。
 *
 * CSV 导出是纯前端拼装（usageMath.buildUsageCsv，三张表 + UTF-8 BOM），
 * 与日志页导出同一交互范式：Blob → a.download，不需要后端参与；
 * 文件名带所选范围（如 usage-30d），导出口径与当前所见一致。
 */
export function UsageMatrixSection({
  report,
  rangeDays,
  onRangeChange,
}: {
  report: TokenUsageReport;
  rangeDays: 7 | 30 | 90;
  onRangeChange: (next: 7 | 30 | 90) => void;
}) {
  const { toast } = useToast();
  const m = useMemo(() => buildMatrix(report), [report]);

  // 进入/切档/数据到达时自动滚到最右（今天列贴右缘）：矩阵的核心问题是
  // 「最近用了多少」，初始停在最左等于让用户每次手动拖到底。scrollLeft 超界
  // 会被浏览器 clamp，7 天档不溢出时设置无害；只在这两个依赖变化时执行，
  // 用户之后往左翻旧日期不会被拽回。首列 sticky 保证滚到最右行归属依然清晰。
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
  }, [rangeDays, report]);

  const exportCsv = () => {
    try {
      const csv = buildUsageCsv(report);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cc-bridge-token-usage-${rangeDays}d-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`已导出 CSV（最近 ${rangeDays} 天 · 三张表）`, "success");
    } catch (e) {
      toast(`导出失败：${e}`, "error");
    }
  };

  if (m.tools.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-5 text-center">
        <p className="text-xs text-muted-foreground">
          最近 {rangeDays} 天暂无调用记录
          {rangeDays < 90 && "——更早的调用不会出现在这个窗口里"}
        </p>
        {rangeDays < 90 && (
          <button
            type="button"
            className="mt-2 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] text-primary transition-colors hover:bg-muted"
            onClick={() => onRangeChange(90)}
          >
            查看最近 90 天
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="text-xs font-semibold">
          按天 × 工具
          <span className="ml-1.5 text-[11px] font-medium text-muted-foreground">
            最近 {rangeDays} 天 · 深度 = 格内估算 tokens
          </span>
        </div>

        {/* 时间范围：与卡片级维度切换同款分段控件样式（小 state 不值得上 Tabs）。 */}
        <div className="ml-auto flex shrink-0 items-center rounded-md border border-border bg-muted/40 p-0.5 text-[11px]">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={rangeDays === r}
              className={`rounded px-2 py-0.5 transition-colors ${
                rangeDays === r
                  ? "bg-background font-semibold text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => onRangeChange(r)}
            >
              {r} 天
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:bg-muted hover:text-foreground"
          title={`导出最近 ${rangeDays} 天的三张表：按天 / 按工具 / 按天×工具（UTF-8 CSV，Excel 可直接打开）`}
        >
          <Icon name="download" size={12} />
          导出 CSV
        </button>
      </div>

      <div ref={scrollRef} className="overflow-x-auto rounded-md border border-border">
        <table className="usage-matrix border-collapse text-[11px]" style={{ borderSpacing: 0 }}>
          <thead>
            <tr>
              <th className="usage-matrix-corner">工具 \ 日期</th>
              {m.dates.map((d) => (
                <th key={d} className="usage-matrix-th">
                  {d.slice(5).replace("-", "/")}
                </th>
              ))}
              <th className="usage-matrix-th usage-matrix-total">合计</th>
            </tr>
          </thead>
          <tbody>
            {m.tools.map((tool, ti) => (
              <tr key={tool}>
                <th className="usage-matrix-rowhead" title={tool}>
                  {toolLabel(tool)}
                </th>
                {m.dates.map((date) => {
                  const c = m.cell.get(`${tool}|${date}`);
                  return (
                    <td key={date} className="usage-matrix-td">
                      {c && (
                        <i
                          className="usage-matrix-cell"
                          style={{ opacity: 0.15 + (c.estTokens / m.max) * 0.85 }}
                          title={`${toolLabel(tool)} · ${date} · ~${fmtWan(c.estTokens)} tok · ${c.calls} 次`}
                        />
                      )}
                    </td>
                  );
                })}
                <td className="usage-matrix-td usage-matrix-total">{fmtWan(m.toolTotals[ti])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10.5px] text-muted-foreground">
        空格 = 当天未调用该工具 · 鼠标悬停看明细 · 完整数据（含零值天）在 CSV 里
      </p>
    </div>
  );
}
