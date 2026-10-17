import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePresence } from "../../hooks/usePresence";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useViewActive } from "../../lib/viewActivity";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 内容卡片 className（尺寸/圆角/表面由调用方指定，沿用 modal-surface） */
  className?: string;
  /** overlay 额外 className */
  overlayClassName?: string;
  /** 点击遮罩是否关闭，默认 true */
  closeOnOverlay?: boolean;
  /** 进出场动画：scale（弹簧缩放，默认）| fade（纯淡入） */
  animation?: "scale" | "fade";
  /** 层级，默认 1000（原 UpdateNotesDialog/VersionHistoryModal 用 1000，Dialog/ConfirmModal 用 50） */
  zIndex?: number;
  ariaLabel?: string;
}

/**
 * 统一弹窗原语（动画质感升级 · 方案 C）。
 *
 * 解决「弹窗只有进场、关闭硬消失」的质感缺口：
 *  - 进场：遮罩淡入 + 内容 scale/opacity 弹入（mount transition 延迟卸载实现退场）
 *  - 退场：遮罩淡出 + 内容 scale-out，再卸载（不再「啪」地消失）
 *  - Esc / 点遮罩 / 关闭按钮统一关闭（调用方只需接 onClose）
 *  - 通过 createPortal 挂到 document.body，避免祖先层叠上下文影响 fixed 定位
 *  - 用户开启「减弱动效」时：退场延时归零、过渡即时（与全局守卫一致）
 *
 * 调用方改写指引：删除自身的 `if (!open) return null` 与遮罩/退场相关代码，
 * 把内容包进 <Modal open={open} onClose={onClose} className="原有的 surface 类">。
 */
export function Modal({
  open,
  onClose,
  children,
  className = "",
  overlayClassName = "",
  closeOnOverlay = true,
  animation = "scale",
  zIndex = 1000,
  ariaLabel,
}: ModalProps) {
  const active = useViewActive();
  const visible = open && active;
  const { mounted, entered } = usePresence(visible);
  // 焦点陷阱（a11y）：Tab 环绕在弹窗内、关闭后焦点归还触发元素。
  // enabled 跟 mounted 走：内容延迟挂载/退场延迟卸载，陷阱只在内容真正存在时生效。
  // Esc 在内容节点处理并停止冒泡，嵌套弹窗优先关闭自己。
  const surfaceRef = useRef<HTMLDivElement>(null);
  useFocusTrap(surfaceRef, { enabled: mounted, onEscape: visible ? onClose : undefined });

  if (!mounted) return null;

  return createPortal(
    <div
      className={`ui-overlay fixed inset-0 flex items-center justify-center bg-black/45 ${overlayClassName}`}
      data-state={entered ? "open" : "closed"}
      data-exiting={!visible || undefined}
      style={{ zIndex }}
      onClick={visible && closeOnOverlay ? onClose : undefined}
    >
      <div
        ref={surfaceRef}
        role="dialog" aria-modal="true" aria-label={ariaLabel}
        data-state={entered ? "open" : "closed"}
        data-exiting={!visible || undefined}
        data-motion={animation}
        className={`ui-surface mx-4 ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
