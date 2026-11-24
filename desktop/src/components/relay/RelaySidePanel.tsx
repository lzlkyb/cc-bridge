import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Modal } from "../ui/Modal";

export function RelaySidePanel({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal open ariaLabel={title} onClose={onClose} animation="fade"
      overlayClassName="relay-drawer-overlay" className="relay-drawer modal-surface">
      <header className="relay-section-head">
        <h2>{title}</h2>
        <Button size="icon" variant="ghost" aria-label={`关闭${title}`} onClick={onClose}>
          <Icon name="close" size={17} />
        </Button>
      </header>
      <div className="relay-drawer-body">{children}</div>
    </Modal>
  );
}
