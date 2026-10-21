import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePresence } from "../../hooks/usePresence";
import { Icon } from "./icon";

/**
 * 设置行「ⓘ」信息按钮 + 按需说明浮层（2026-10-17 文案三层分级的 L1 层）。
 *
 * 分层判据（docs/设置页信息架构与文案分层方案-2026-10-17.md）：
 * 原理 / 边界 / 兼容性说明不再常驻界面（L0 只留 ≤20 字结果短句），
 * 全文搬进这里——信息零丢失，静读密度下降。
 *
 * 定位与关闭：
 * - `position: fixed` 零占位：占高度会触发终端 `fit`、远端 TUI 重排（布局铁律）；
 * - 首开在 useLayoutEffect 里量按钮矩形定位（防闪帧），右缘/底缘自动收进视口；
 * - 外部点击（捕获）/ Esc / 任意滚动 / resize 即关：fixed 坐标随滚动失效，
 *   重算不如关掉——用户滚走说明注意力已经转移；
 * - Esc 不穿透（同 Menu 的处理），关闭后焦点回 ⓘ 按钮。
 */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { mounted, entered } = usePresence(open);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  const W = 320;
  const place = () => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const h = popRef.current?.offsetHeight ?? 0;
    let left = b.left + b.width / 2 - W / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - W - 12));
    let top = b.bottom + 8;
    if (h > 0 && top + h > window.innerHeight - 12) top = Math.max(12, b.top - h - 8);
    setPos({ top, left });
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus({ preventScroll: true });
    };
    const close = () => setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={`「${label}」的详细说明`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="info-trigger grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <span className={`grid h-4 w-4 place-items-center rounded-full border transition-colors ${
          open
            ? "border-primary/50 bg-primary/10 text-primary"
            : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground"
        }`}>
          <Icon name="info" size={10} />
        </span>
      </button>
      {mounted && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={label}
          data-state={entered ? "open" : "closed"}
          data-exiting={!open || undefined}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: W }}
          className="animate-fade-in z-50 rounded-xl border border-border bg-card p-3 shadow-lg"
        >
          <div className="mb-1 text-[13px] font-semibold text-foreground">{label}</div>
          <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>
        </div>
      )}
    </>
  );
}
