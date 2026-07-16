import type { ReactNode } from "react";

/**
 * 设置页通用「行」骨架：左侧标签 + 说明，右侧控制区。
 * 用于统一各 Tab 原先手写的「标签 + 控件」布局（端口行 / 开机启动 / 安装位置 / 保留天数等）。
 * 与 ToggleRow（开关行）、s-row（带图标行）共用同一套间距 / 边框 / 已保存反馈 / 危险态，视觉一致。
 *
 * - layout="row"（默认）：横排两端对齐，适合「标签 + Switch / 按钮 / 输入+按钮」。
 * - layout="stack"：竖排，标签在上、控制区在中、说明在下，适合「数值输入 + 说明」。
 * - danger：左侧红底（与 ToggleRow 一致），用于高风险项。
 * - last：去掉底边框（卡片内最后一行时传 true，与 ToggleRow 约定一致）。
 */
export function SettingsRow({
  label,
  sub,
  control,
  saved = false,
  danger = false,
  last = false,
  layout = "row",
}: {
  label: ReactNode;
  sub?: ReactNode;
  control?: ReactNode;
  saved?: boolean;
  danger?: boolean;
  last?: boolean;
  layout?: "row" | "stack";
}) {
  const isStack = layout === "stack";
  return (
    <div
      className={[
        "flex gap-3 py-3",
        isStack ? "flex-col items-stretch" : "flex-row items-center justify-between",
        last ? "" : "border-b border-border",
        danger ? "-mx-3 rounded-lg bg-destructive/5 px-3" : "",
      ].join(" ")}
    >
      {/* 标签 + 说明（横排时说明在标签下方、控制区左侧；竖排时说明在控制区下方） */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {saved && <span className="text-xs font-normal text-success">已保存 ✓</span>}
        </div>
        {!isStack && sub && (
          <div className={`mt-0.5 text-xs ${danger ? "text-destructive" : "text-muted-foreground"}`}>
            {sub}
          </div>
        )}
      </div>

      {/* 控制区（横排时居右，竖排时置于标签下方） */}
      {control && <div className="shrink-0">{control}</div>}

      {/* 竖排时说明置于控制区下方 */}
      {isStack && sub && (
        <div className={`text-xs ${danger ? "text-destructive" : "text-muted-foreground"}`}>{sub}</div>
      )}
    </div>
  );
}
