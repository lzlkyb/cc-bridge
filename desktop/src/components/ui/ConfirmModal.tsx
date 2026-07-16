import { createPortal } from "react-dom";
import type { ReactNode } from "react";

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 内容卡片最大宽度，默认 md（与原自建确认弹窗一致） */
  maxWidth?: "sm" | "md" | "lg";
  /** 层级，默认 50（与原自建弹窗 z-50 一致）；RestoreBackupDialog 原用 z-[1001] */
  zIndex?: number;
}

/**
 * 确认型弹窗统一外壳：遮罩 + 居中 + 点击遮罩关闭 + 内容卡片。
 * 样式与项目原有自建弹窗保持一致（max-w-md、bg-black/50 backdrop-blur-sm、
 * rounded-xl border bg-card p-5 shadow-pop、animate-scale-in），仅做代码去重。
 */
export function ConfirmModal({
  open,
  onClose,
  children,
  maxWidth = "md",
  zIndex = 50,
}: ConfirmModalProps) {
  if (!open) return null;
  const maxW =
    maxWidth === "sm" ? "max-w-sm" : maxWidth === "lg" ? "max-w-lg" : "max-w-md";
  return createPortal(
    <div
      className={`fixed inset-0 z-[${zIndex}] flex items-center justify-center bg-black/50 backdrop-blur-sm`}
      onClick={onClose}
    >
      <div
        className={`animate-scale-in mx-4 w-full ${maxW} rounded-xl modal-surface p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
