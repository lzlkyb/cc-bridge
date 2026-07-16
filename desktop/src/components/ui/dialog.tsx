import { type ReactNode } from "react";
import { Modal } from "./Modal";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function Dialog({ open, onClose, children }: DialogProps) {
  return (
    <Modal open={open} onClose={onClose} zIndex={50} className="mx-4 w-full max-w-lg rounded-lg modal-surface p-6">
      {children}
    </Modal>
  );
}

export function DialogHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mb-4 flex items-center justify-between ${className}`}>{children}</div>;
}

export function DialogTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h3 className={`text-lg font-semibold ${className}`}>{children}</h3>;
}
