import { useEffect, useRef, type ReactNode } from "react";
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
  const dialogRef = useRef<HTMLDivElement>(null);
  // 用 ref 拿最新的 onCancel，而不是把它入 effect 依赖：调用方普遍传内联箭头函数，
  // 入依赖会让 effect 随父组件每次重渲染重跑，反复抢焦点到第一个按钮。
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  // 焦点陷阱 + 关闭后焦点归还（单套 UI 始终启用，提升键盘可达性）
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    if (!node) return;
    const focusables = node.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusables[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Esc 关自己，并阻止继续冒泡。嵌在 `Modal` 里时尤其重要：
      // Modal 把 Esc 监听挂在 window 上，不拦住的话按一下 Esc 关掉的是**父弹框**，
      // 确认框自己的 state 反而残留下来，下次打开父弹框时会自己弹出来。
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelRef.current();
        return;
      }
      if (e.key !== "Tab" || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm dlg-mask"
      style={{ zIndex }}
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        className="animate-scale-in mx-4 w-full max-w-md rounded-xl modal-surface p-5 dlg"
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
        <div className="mt-4 flex justify-end gap-2 dlg-act">
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
