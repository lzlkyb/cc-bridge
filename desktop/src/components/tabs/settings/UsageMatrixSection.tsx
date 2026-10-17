import { useMemo } from "react";
import type { TokenUsageReport } from "../../../lib/types";
import { buildMatrix, buildUsageCsv, fmtWan } from "../../../lib/usageMath";
import { toolLabel } from "../../../lib/utils";
import { Icon } from "../../ui/icon";
import { useToast } from "../../ui/toast";

/**
 * 「按天 × 工具」矩阵视图（TokenUsageGroup 的第二维度，批D）。
 *
 * 行 = 工具（按合计降序，与排行同口径但**全集**——排行只留 Top10），
 * 列 = 日期（旧→新，与 90 天查询窗口一致），格底色深浅 = 格值 / 全表最大。
 * 横向可滚：90 天 × 24px 塞不下视口，第一列 sticky 保证滚动了也知道看的是哪行。
 *
 * CSV 导出是纯前端拼装（usageMath.buildUsageCsv，三张表 + UTF-8 BOM），
 * 与日志页导出同一交互范式：Blob → a.download，不需要后端参与。
 */
export function UsageMatrixSection({ report }: { report: TokenUsageReport }) {
  const { toast } = useToast();
  const m = useMemo(() => buildMatrix(report), [report]);

  const exportCsv = () => {
    try {
      const csv = buildUsageCsv(report);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cc-bridge-token-usage-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast("已导出 CSV（按天 / 按工具 / 按天×工具 三张表）", "success");
    } catch (e) {
      toast(`导出失败：${e}`, "error");
    }
  };

  if (m.tools.length === 0) {
    return <p className="text-xs text-muted-foreground">窗口内暂无按工具的调用明细。</p>;
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <div className="text-xs font-semibold">
          按天 × 工具
          <span className="ml-1.5 text-[11px] font-medium text-muted-foreground">
            深度 = 格内估算 tokens
          </span>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:bg-muted hover:text-foreground"
          title="导出三张表：按天 / 按工具 / 按天×工具（UTF-8 CSV，Excel 可直接打开）"
        >
          <Icon name="download" size={12} />
          导出 CSV
        </button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
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
