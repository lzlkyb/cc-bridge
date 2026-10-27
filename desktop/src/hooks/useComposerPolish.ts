import { useCallback, useRef, useState } from "react";

/** 润色只生成候选稿；采用前不改变正在编辑的正文。 */
export function useComposerPolish(onPolish?: (draft: string) => Promise<string | null>) {
  const [preview, setPreview] = useState<{ source: string; text: string } | null>(null);
  const [polishing, setPolishing] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    // A response that arrives after typing or sending belongs to the old draft.
    generation.current += 1;
    setPreview(null);
  }, []);

  const run = async (draft: string) => {
    if (!draft.trim() || !onPolish || inFlight.current) return;
    const version = ++generation.current;
    inFlight.current = true;
    setPolishing(true);
    setPreview(null);
    try {
      const text = await onPolish(draft.trim());
      if (text?.trim() && generation.current === version) {
        setPreview({ source: draft, text: text.trim() });
      }
    } finally {
      inFlight.current = false;
      setPolishing(false);
    }
  };

  return { preview, polishing, run, reset, enabled: Boolean(onPolish) };
}
