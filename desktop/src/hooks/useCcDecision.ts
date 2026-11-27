import { useRef, useState } from "react";

/** Inline and focused review share one submission, including failures and retries. */
export function useCcDecision() {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (send: () => void | Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await send();
    } catch (reason) {
      setError(`提交失败：${String(reason).replace(/^Error: /, "")}。请重试或查看当前会话状态。`);
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return { busy, error, submit };
}
