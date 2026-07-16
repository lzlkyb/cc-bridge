import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";
import { Icon } from "./icon";

export type ConfirmDialogVariant = "default" | "destructive";

interface ConfirmDialogProps {
  title: string;
  description?: ReactNode;
  /** 额外内容（风险提示条、复选框、清单等），渲染在 description 和按钮之间。 */
  children?: ReactNode;
  /** default：中性操作（如重置为默认）；destructive：不可逆/高风险操作（红色强调）。 */
  variant?: ConfirmDialogVariant;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * D12：统一确认弹窗，替换 ShellRiskModal/ConfirmModal（SecurityOverview.tsx/SettingsToggles.tsx
 * 各有一份重复实现）/ SettingsToggles 的 confirmReset 内联弹窗 / LogTab 的 confirmClear 内联弹窗。
 * 一律走 createPortal(document.body)，避免祖先层叠上下文影响 `fixed inset-0` 定位。
 */
export function ConfirmDialog({
  title,
  description,
  children,
  variant = "default",
  confirmLabel,
  cancelLabel = "取消",
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="animate-scale-in mx-4 w-full max-w-md rounded-xl modal-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h4
          className={`mb-2 flex items-center gap-2 text-base font-semibold ${
            variant === "destructive" ? "text-destructive" : ""
          }`}
        >
          <Icon
            name="alertTriangle"
            size={18}
            className={variant === "default" ? "text-warning" : undefined}
          />
          {title}
        </h4>
        {description && <p className="mb-3 text-sm text-muted-foreground">{description}</p>}
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            size="sm"
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel ?? "确定"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
