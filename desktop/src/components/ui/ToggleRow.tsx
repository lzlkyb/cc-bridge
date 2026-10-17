import type { ReactNode } from "react";
import { Switch } from "./switch";
import { SavedHint } from "./SavedHint";
import { InfoPopover } from "./InfoPopover";

/**
 * 设置页通用的「开关行」：左侧标签 + 描述，右侧 Switch。
 * 共享组件，供 `tabs/settings/` 下的各张设置卡与安全页复用。
 *
 * 文案三层分级（2026-10-17）：
 * - `sub` 改为可选——原理 / 边界类长解释迁去 `info`（ⓘ popover），L0 常显层
 *   只留 ≤20 字结果短句或干脆不留（判据见 docs/设置页信息架构与文案分层方案）；
 * - `sub` 缺省时不渲染说明块（旧行为是常驻一块，现在行可以只有标签 + 开关）。
 */
export function ToggleRow({
  label,
  sub,
  info,
  checked,
  onChange,
  variant = "default",
  danger = false,
  last = false,
  saved = false,
  id,
}: {
  label: string;
  /** L0 常显短句：≤20 字结果性描述；原理/边界请改传 info。 */
  sub?: string;
  /** L1 按需说明：传入后行尾渲染 ⓘ，点击弹 popover 显示全文。 */
  info?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  variant?: "default" | "danger";
  danger?: boolean;
  last?: boolean;
  saved?: boolean;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`srow flex items-center justify-between gap-4 py-3.5 ${
        last ? "" : "border-b"
      } ${danger ? "-mx-3 rounded-lg bg-destructive/5 px-3" : ""}`}
    >
      <div className="grow min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="t text-sm font-medium">{label}</span>
          {saved && <SavedHint>已保存</SavedHint>}
          {info && <InfoPopover label={label}>{info}</InfoPopover>}
        </div>
        {sub && (
          <div className={`d mt-0.5 text-xs ${danger ? "text-destructive-ink" : "text-muted-foreground"}`}>
            {sub}
          </div>
        )}
      </div>
      <Switch checked={checked} onChange={onChange} variant={variant} ariaLabel={label} />
    </div>
  );
}
