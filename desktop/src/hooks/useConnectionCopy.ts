import { useEffect, useRef, useState } from "react";
import { useCurrentConnection } from "./useCurrentConnection";
import { invoke } from "../lib/tauri";
import { copyText } from "../lib/utils";
import type { StaticStatus } from "../lib/types";
import { toast } from "../components/ui/toast";

export type ConnectionCopyKind = "address" | "command" | "ip-update" | "token-update";
export function useConnectionCopy(status?: StaticStatus, draftIdentity?: string) {
  const access = useCurrentConnection(status);
  const currentKey = draftIdentity ?? access?.targetKey ?? "";
  const latest = useRef(currentKey);
  latest.current = currentKey;
  const [copied, setCopied] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setCopied("");
    return () => clearTimeout(timer.current);
  }, [currentKey]);
  const copy = async (kind: ConnectionCopyKind, message?: string, expectedText?: string) => {
    const key = latest.current;
    try {
      const result = await invoke<{ text: string; targetKey: string }>("get_connection_copy", { kind });
      if (!alive.current) return false;
      if (key !== latest.current || (expectedText !== undefined && expectedText !== result.text) ||
        (draftIdentity === undefined && !!key && key !== result.targetKey)) {
        toast("接入目标已变化，请重新复制当前配置。", "warning");
        return false;
      }
      if (!result.text) { toast("当前接入没有可复制内容，请查看接入卡片。", "warning"); return false; }
      let success = false;
      await copyText(result.text, () => {
        if (!alive.current || key !== latest.current) return;
        success = true; setCopied(`${key}:${kind}`);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(""), 2000);
        if (message) toast(message, "success");
        if (kind !== "address") void invoke(kind === "command" ? "connection_command_copied" : "connection_update_copied", { targetKey: result.targetKey })
          .catch(error => { if (alive.current && key === latest.current) toast(`命令已复制，保存接入目标失败：${error}`, "warning"); });
      }, error => { if (alive.current && key === latest.current) toast(`复制失败：${error}`, "error"); });
      return success;
    } catch (error) { if (alive.current && key === latest.current) toast(String(error), "warning"); return false; }
  };
  return { copy, isCopied: (kind: ConnectionCopyKind) => copied === `${currentKey}:${kind}` };
}
