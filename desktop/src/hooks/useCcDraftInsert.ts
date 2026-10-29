import { useEffect, type RefObject, type Dispatch, type SetStateAction } from "react";
export function useCcDraftInsert(box: RefObject<HTMLDivElement>, area: RefObject<HTMLTextAreaElement>, setValue: Dispatch<SetStateAction<string>>) {
  useEffect(() => {
    const panel = box.current?.closest("[data-cc-panel]");
    const insert = (event: Event) => { const text = (event as CustomEvent<string>).detail; if (typeof text !== "string") return;
      setValue(previous => previous + (previous ? "\n\n" : "") + text); area.current?.focus(); };
    panel?.addEventListener("cc-append-draft", insert);
    return () => panel?.removeEventListener("cc-append-draft", insert);
  }, [box, area, setValue]);
}
