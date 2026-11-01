import { useCallback, useRef, useState, type Dispatch, type MutableRefObject } from "react";
import { invoke } from "../lib/tauri";
import type { CcAction } from "../lib/ccReducer";
import type { CcImage } from "../lib/ccImage";
import type { CcTarget } from "./useCcSession";
import type { CcInputStatus } from "../lib/ccInput";

type Options = {
  sessionIdRef: MutableRefObject<number | null>; targetRef: MutableRefObject<CcTarget>;
  sessionId: string | null; ready: boolean; running: boolean; busy: boolean;
  dispatch: Dispatch<CcAction>;
  start: (text: string, images: CcImage[]) => Promise<boolean>;
};

/** Unknown invoke outcomes reuse their UUID. A retry must never write the same correction twice. */
export function useCcSteering(options: Options) {
  const latest = useRef(options); latest.current = options;
  const inFlight = useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = useCallback(async (mode: "steer" | "now", text: string, images: CcImage[]) => {
    const o = latest.current;
    if (inFlight.current) return false;
    if (!o.ready || o.busy) { o.dispatch({ type: "error", message: "会话正在准备，草稿已保留，请稍候发送" }); return false; }
    const sid = o.sessionIdRef.current;
    const target = { ...o.targetRef.current };
    const key = JSON.stringify([sid, o.sessionId, target.connectionId, target.cwd, mode, text, images.map(i => [i.mediaType, i.data])]);
    // Even after a completed turn, reconcile an uncertain attempt before starting another one.
    if (!o.running && attempt.current?.key !== key) return o.start(text, images);
    if (sid === null || !o.sessionId) { o.dispatch({ type: "error", message: "会话尚未就绪，草稿已保留" }); return false; }
    const id = attempt.current?.key === key ? attempt.current.id : crypto.randomUUID();
    attempt.current = { key, id };
    inFlight.current = true; setBusy(true);
    try {
      const status = await invoke<CcInputStatus>("cc_steer", { sessionId: sid, input: {
        messageId: id, expectedSessionId: o.sessionId, mode,
        req: { ...target, text, images: images.map(i => ({ mediaType: i.mediaType, data: i.data, thumb: i.thumb })) },
      } });
      // The persisted receipt already explains known delivery failures beside the retained draft.
      if (["failed", "unconfirmed", "preparing"].includes(status)) return false;
      if (!["written", "received", "processing", "complete"].includes(status)) {
        o.dispatch({ type: "error", message: "没有收到有效的插话回执；草稿已保留，不会自动重发" });
        return false;
      }
      attempt.current = null;
      return true;
    } catch (error) {
      o.dispatch({ type: "error", message: `${String(error)}；草稿与附件保留` });
      return false;
    } finally { inFlight.current = false; setBusy(false); }
  }, []);
  const steer = useCallback((text: string, images: CcImage[]) => submit("steer", text, images), [submit]);
  const sendNow = useCallback((text: string, images: CcImage[]) => submit("now", text, images), [submit]);
  return { steer, sendNow, busy };
}
