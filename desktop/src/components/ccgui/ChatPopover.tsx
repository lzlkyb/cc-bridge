import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../hooks/useAnchoredPopover";
import { useFocusTrap } from "../../hooks/useFocusTrap";

/** Portals keep menus clear of the workspace's clipping and glass stacking contexts. */
export function ChatPopover({ anchorRef, onClose, label, width = 296, children }: {
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  label: string;
  width?: number;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const style = useAnchoredPopover(anchorRef, true, { width, maxH: 480 });
  useFocusTrap(box, { enabled: !!style, onEscape: onClose });
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !anchorRef.current?.contains(target)) close.current();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [anchorRef]);
  return createPortal(
    <div ref={box} role="dialog" aria-label={label} className="cc-chat-popover"
      style={style ?? { position: "fixed", visibility: "hidden" }}>
      {children}
    </div>, document.body,
  );
}
