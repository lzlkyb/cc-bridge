import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import type { RestartSafety, UpdateActivity } from "../lib/updatePresentation";

export function useUpdateRestartSafety(active: boolean) {
  const [safety, setSafety] = useState<RestartSafety>({ state: "checking" });
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<RestartSafety> => {
    const request = ++generation.current;
    let result: RestartSafety;
    try {
      const activity = await invoke<UpdateActivity>("update_activity");
      // A missing/old backend must never be interpreted as an idle application.
      if (!activity ||
          ![activity.conversations, activity.agents, activity.commands, activity.transfers]
            .every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid activity");
      result = { state: "known", activity };
    } catch {
      result = { state: "unknown" };
    }
    if (request === generation.current) setSafety(result);
    return result;
  }, []);

  useEffect(() => {
    if (!active) return;
    const checkVisible = () => { if (!document.hidden && !document.documentElement.hasAttribute("data-app-hidden")) void refresh(); };
    checkVisible();
    const timer = window.setInterval(checkVisible, 5000);
    document.addEventListener("visibilitychange", checkVisible);
    return () => {
      // This numeric request generation intentionally invalidates all outstanding responses.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++generation.current;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkVisible);
    };
  }, [active, refresh]);
  return { safety, refresh };
}
