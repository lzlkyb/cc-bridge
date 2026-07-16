import type { ReactNode } from "react";
import { Modal } from "./Modal";

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
 * 现基于统一 <Modal> 原语（动画质感升级），获得进出场过渡；调用方若用条件渲染控制显隐，
 * 进出场由父级挂载/卸载驱动；若用 open 受控，则自带退场动画。
 */
export function ConfirmModal({
  open,
  onClose,
  children,
  maxWidth = "md",
  zIndex = 50,
}: ConfirmModalProps) {
  const maxW =
    maxWidth === "sm" ? "max-w-sm" : maxWidth === "lg" ? "max-w-lg" : "max-w-md";
  return (
    <Modal open={open} onClose={onClose} zIndex={zIndex} className={`mx-4 w-full ${maxW} rounded-xl modal-surface p-5`}>
      {children}
    </Modal>
  );
}
