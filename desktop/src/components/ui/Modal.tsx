import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";

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
}: ModalProps) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const reduced = usePrefersReducedMotion();

  // 进场：open 变 true → 挂载 → 下一帧切到 entered 触发过渡
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  // 退场：open 变 false → entered=false → 延时卸载（reduced 时即时）
  useEffect(() => {
    if (!open && mounted) {
      setEntered(false);
      const delay = reduced ? 0 : 200;
      const t = setTimeout(() => setMounted(false), delay);
      return () => clearTimeout(t);
    }
  }, [open, mounted, reduced]);

  // Esc 关闭
  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mounted, onClose]);

  if (!mounted) return null;

  const overlayState = entered ? "opacity-100" : "opacity-0";
  const surfaceState =
    animation === "scale"
      ? entered
        ? "opacity-100 scale-100"
        : "opacity-0 scale-95"
      : entered
        ? "opacity-100"
        : "opacity-0";

  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm transition-opacity duration-200 ${overlayState} ${overlayClassName}`}
      style={{ zIndex }}
      onClick={closeOnOverlay ? onClose : undefined}
    >
      <div
        className={`mx-4 transition-all duration-200 ease-out-expo ${surfaceState} ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
