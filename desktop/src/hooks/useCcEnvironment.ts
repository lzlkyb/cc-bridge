import { useCallback, useRef, useState, type Dispatch, type MutableRefObject } from "react";
import { invoke } from "../lib/tauri";
import type { CcProbe } from "../lib/ccEventTypes";
import type { CcAction } from "../lib/ccReducer";
import type { CcTarget } from "./useCcSession";

/** 目标环境探测与路径缓存；旧目标的迟到结果不能改变新目标的连接状态。 */
export function useCcEnvironment(targetRef: MutableRefObject<CcTarget>, errors: string[], dispatch: Dispatch<CcAction>) {
  const [probe, setProbe] = useState<CcProbe | null>(null);
  /**
   * 最近一次探测到的 claude 绝对路径 + 它属于哪个目标。
   *
   * 远端**必须**用绝对路径执行：真正跑起来的 bash 是非登录的，拿不到
   * `~/.local/bin` 那份 PATH，直接写 `claude` 会「命令不存在」。
   * 记 `connId` 是为了防止换了连接还用上一个目标的路径 —— 那会让它 exec 一个
   * 根本没装在这台机器上的文件。
   */
  const probeRef = useRef<{ connId: string | null; path: string } | null>(null);
  /** 探测 claude 是否可用。进页面、换连接、点「重试」时调。 */
  const probeErrorRef = useRef<string | null>(null);
  const probeAttemptRef = useRef(0);
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const runProbe = useCallback(async (): Promise<CcProbe | null> => {
    const t = targetRef.current;
    const attempt = ++probeAttemptRef.current;
    try {
      const res = await invoke<CcProbe>("cc_probe", {
        connectionId: t.connectionId,
        claudePath: t.claudePath,
      });
      if (attempt !== probeAttemptRef.current || t.connectionId !== targetRef.current.connectionId) return null;
      setProbe(res);
      if (res.found && probeErrorRef.current) {
        for (let index = errorsRef.current.length - 1; index >= 0; index--) {
          if (errorsRef.current[index] === probeErrorRef.current) dispatch({ type: "errorDismiss", index });
        }
        probeErrorRef.current = null;
      }
      // 路径要留着给 `start` 用：远端靠它才能 exec 到 claude。
      probeRef.current =
        res.found && res.path.trim() ? { connId: t.connectionId, path: res.path.trim() } : null;
      if (!res.found) { probeErrorRef.current = res.message; dispatch({ type: "error", message: res.message }); }
      return res;
    } catch (e) {
      if (attempt !== probeAttemptRef.current || t.connectionId !== targetRef.current.connectionId) return null;
      const msg = String(e);
      probeErrorRef.current = msg;
      setProbe({ found: false, path: "", version: null, message: msg, target: "" });
      dispatch({ type: "error", message: msg });
      return null;
    }
  }, [dispatch, targetRef]);

  return { probe, runProbe, probeRef };
}
