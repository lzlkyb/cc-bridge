import { useId, type ReactNode } from "react";
import { SavedHint } from "./SavedHint";
import { InfoPopover } from "./InfoPopover";

/**
 * 设置页通用「行」骨架：左侧标签 + 说明，右侧控制区。
 * 用于统一各 Tab 原先手写的「标签 + 控件」布局（端口行 / 开机启动 / 安装位置 / 保留天数等）。
 * 与 ToggleRow（开关行）、s-row（带图标行）共用同一套间距 / 边框 / 已保存反馈 / 危险态，视觉一致。
 *
 * - layout="row"（默认）：横排两端对齐，适合「标签 + Switch / 按钮 / 输入+按钮」。
 * - layout="stack"：竖排，标签在上、控制区在中、说明在下，适合「数值输入 + 说明」。
 * - danger：左侧红底（与 ToggleRow 一致），用于高风险项。
 * - last：去掉底边框（卡片内最后一行时传 true，与 ToggleRow 约定一致）。
 *
 * 文案三层分级（2026-10-17，与 ToggleRow 同批）：
 * - `sub` 改为可选；原理 / 边界类长解释改传 `info`（ⓘ popover，L1 层）；
 * - `info` 的 ⓘ 挂在标签行尾，stack 布局同样生效。
 */
export function SettingsRow({
  label,
  sub,
  info,
  control,
  saved = false,
  danger = false,
  last = false,
  layout = "row",
  id, controlId, pending = false, error,
}: {
  label: ReactNode;
  /** L0 常显短句：≤20 字结果性描述；原理/边界请改传 info。 */
  sub?: ReactNode;
  /** L1 按需说明：传入后标签行尾渲染 ⓘ，点击弹 popover 显示全文。 */
  info?: ReactNode;
  control?: ReactNode;
  saved?: boolean;
  danger?: boolean;
  last?: boolean;
  layout?: "row" | "stack";
  id?: string;
  controlId?: string;
  pending?: boolean;
  error?: string;
}) {
  const isStack = layout === "stack";
  const generatedId = useId();
  const labelId = `${id ?? generatedId}-label`;
  return (
    <div
      id={id} tabIndex={id ? -1 : undefined} role="group" aria-labelledby={labelId} aria-busy={pending || undefined}
      className={[
        "srow flex gap-3 py-3",
        isStack ? "stack flex-col items-stretch" : "flex-row items-center justify-between",
        last ? "" : "divider-x",
        danger ? "-mx-3 rounded-lg bg-destructive/5 px-3" : "",
      ].join(" ")}
    >
      {/* 标签 + 说明（横排时说明在标签下方、控制区左侧；竖排时说明在控制区下方） */}
      <div className="grow min-w-0">
        <div className="flex items-center gap-2">
          {controlId ? <label id={labelId} htmlFor={controlId} className="t text-sm font-medium">{label}</label> : <span id={labelId} className="t text-sm font-medium">{label}</span>}
          {saved && <SavedHint>已保存</SavedHint>}
          {info && <InfoPopover label={typeof label === "string" ? label : "详细说明"}>{info}</InfoPopover>}
        </div>
        {!isStack && sub && (
          <div className={`d mt-0.5 text-xs ${danger ? "text-destructive-ink" : "text-muted-foreground"}`}>
            {sub}
          </div>
        )}
      </div>

      {/* 控制区（横排时居右，竖排时置于标签下方） */}
      {control && <div className="srow-control shrink-0">{control}</div>}

      {/* 竖排时说明置于控制区下方 */}
      {isStack && sub && (
        <div className={`d text-xs ${danger ? "text-destructive-ink" : "text-muted-foreground"}`}>{sub}</div>
      )}
      {(pending || error) && <div className={`settings-row-feedback text-xs ${error ? "text-destructive-ink" : "text-muted-foreground"}`} role={error ? "alert" : "status"}>{error ?? "保存中…"}</div>}
    </div>
  );
}
