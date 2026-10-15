import { type ReactNode } from "react";
import { Button } from "./button";
import { Icon } from "./icon";
import { Modal } from "./Modal";
import { useDialogDismiss } from "../../hooks/useDialogDismiss";

export type ConfirmDialogVariant = "default" | "destructive";

interface ConfirmDialogProps {
  open?: boolean;
  title: string;
  description?: ReactNode;
  /** 额外内容（风险提示条、复选框、清单等），渲染在 description 和按钮之间。 */
  children?: ReactNode;
  /** default：中性操作（如重置为默认）；destructive：不可逆/高风险操作（红色强调）。 */
  variant?: ConfirmDialogVariant;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  /**
   * 层级，默认 50。
   *
   * **嵌在另一个弹框里时必须传更大的值**：`Modal` 的默认层级是 1000
   * （版本历史 / 更新说明那几个就是 1000），两者都 portal 到 body、是兄弟节点，
   * 不抬层级的话确认框会被盖在父弹框的遮罩下面：看不见也点不到，
   * 而点击会落到父弹框遮罩上把父弹框关掉。`ConfirmModal` 同理（它默认也是 50）。
   */
  zIndex?: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * D12：统一确认弹窗，替换当时散在多处的重复实现（SecurityOverview 与原 SettingsToggles
 * 各有一份 ShellRiskModal/ConfirmModal）/ 重置确认弹窗 / LogTab 的 confirmClear 内联弹窗。
 * 一律走 createPortal(document.body)，避免祖先层叠上下文影响 `fixed inset-0` 定位。
 */
export function ConfirmDialog({
  open = true,
  title,
  description,
  children,
  variant = "default",
  confirmLabel,
  cancelLabel = "取消",
  confirmDisabled = false,
  zIndex = 50,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const { closing, dismiss } = useDialogDismiss(onCancel, open);
  return (
    <Modal open={open && !closing} ariaLabel={title} onClose={() => dismiss()} zIndex={zIndex} className="w-full max-w-md rounded-xl modal-surface p-5 dlg">
        <h4
          className={`mb-2 flex items-center gap-2 text-base font-semibold ${
            variant === "destructive" ? "text-destructive-ink" : ""
          }`}
        >
          <Icon
            name="alertTriangle"
            size={18}
            className={variant === "default" ? "text-warning-ink" : undefined}
          />
          {title}
        </h4>
        {description && <p className="mb-3 text-sm text-muted-foreground">{description}</p>}
        {children}
        <div className="mt-4 flex justify-end gap-2 dlg-act">
          <Button variant="outline" size="sm" onClick={() => dismiss()}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            size="sm"
            disabled={confirmDisabled || closing}
            onClick={() => dismiss(onConfirm)}
          >
            {confirmLabel ?? "确定"}
          </Button>
        </div>
    </Modal>
  );
}
