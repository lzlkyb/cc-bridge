import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { appendCcDraft, quoteCcText } from "../../lib/ccDraftInsert";
export function SelectionQuote({ scrollRef }: { scrollRef: RefObject<HTMLDivElement> }) {
  const [quote, setQuote] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const root = scrollRef.current;
    const update = () => { const selection = window.getSelection(), text = selection?.toString().trim();
      if (!root?.offsetParent || !text || !selection?.rangeCount || !root?.contains(selection.anchorNode) || !root.contains(selection.focusNode)) { setQuote(null); return; }
      const rect = selection.getRangeAt(0).getBoundingClientRect(); setQuote({ text, x: Math.max(8, Math.min(window.innerWidth - 110, rect.left)), y: Math.max(8, rect.top - 36) }); };
    const clear = () => setQuote(null); const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    document.addEventListener("keydown", onKey); document.addEventListener("selectionchange", update); root?.addEventListener("scroll", clear); window.addEventListener("resize", clear);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("selectionchange", update); root?.removeEventListener("scroll", clear); window.removeEventListener("resize", clear); };
  }, [scrollRef]);
  return quote && createPortal(<button type="button" className="cc-selection-quote" style={{ left: quote.x, top: quote.y }} onMouseDown={e => e.preventDefault()} onClick={() => { if (scrollRef.current) appendCcDraft(scrollRef.current, quoteCcText(quote.text)); setQuote(null); window.getSelection()?.removeAllRanges(); }}>引用追问</button>, document.body);
}
