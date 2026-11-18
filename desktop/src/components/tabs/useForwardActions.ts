import { useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { getTunnelStatus, matchesRunning, startTunnel } from "../../lib/sshTunnelStore";
import { manualForwardStatus } from "../../lib/forwardOwnership";
import { forwardConflict } from "../../lib/forwardPresentation";
import type { ForwardAuto, ForwardRule, SshConnection } from "../../lib/types";
import type { useForwardContext } from "../../hooks/useForwardContext";
import type { useForwardDraft } from "./useForwardDraft";
import { toast } from "../ui/toast";

type Operation = "save" | "start" | "stop" | "auto";
export function useForwardActions(conn: SshConnection, context: ReturnType<typeof useForwardContext>, draft: ReturnType<typeof useForwardDraft>) {
  const [operation, setOperation] = useState<Operation | null>(null);
  const [secret, setSecret] = useState("");
  const locked = useRef(false);
  const ready = !!context.data && !context.error;
  const perform = async <T,>(next: Operation, action: () => Promise<T>): Promise<T | undefined> => {
    // A ref also blocks a second click before React has rendered the disabled controls.
    if (locked.current || !ready) return;
    locked.current = true; setOperation(next);
    try { return await action(); }
    catch (error) { toast(`转发操作未完成：${error}`, "error"); }
    finally { locked.current = false; setOperation(null); }
  };
  const applyLatest = async (oneTime?: string): Promise<boolean> => {
    // Saving updates the server record asynchronously; never start from the editor's old closure.
    const fresh = (await context.refetch({ throwOnError: true })).data;
    if (!fresh) throw new Error("暂时无法读取转发设置，请重新读取后再试。");
    const conflict = fresh.conflicts[0]?.message || fresh.manualRules.map(rule => forwardConflict(rule, fresh.manualRules, fresh)).find(Boolean);
    if (conflict) { toast(conflict, "error"); return false; }
    const enabled = fresh.manualRules.some(rule => rule.enabled);
    if (!enabled) {
      if (fresh.manualStatus) await invoke("ssh_tunnel_stop", { connectionId: conn.id });
      setSecret(""); void context.refetch();
      return true;
    }
    // 以本地实时状态为准：refetch 回来的 manualStatus 可能赶在隧道被停/被顶替的
    // 瞬间返回 null，拿它判断「已在运行」会漏判，白白重启一条好端端的隧道。
    const live = manualForwardStatus(
      getTunnelStatus(conn.id) ?? fresh.manualStatus ?? undefined,
      fresh,
    );
    if (!oneTime && live?.state === "up" && live.rules.every(rule => rule.state === "listening") && matchesRunning(fresh.manualRules, live)) {
      toast("配置已保存，当前转发保持运行。", "success");
      return true;
    }
    const credentials = oneTime ? conn.authType === "key" ? { passphrase: oneTime } : { password: oneTime } : undefined;
    const accepted = await startTunnel(conn, credentials);
    if (accepted) {
      setSecret("");
      toast("正在建立转发，访问入口就绪后可复制地址。", "info");
      void context.refetch();
    }
    return accepted;
  };
  const saveRule = (rule: ForwardRule, existing: boolean, apply: boolean) => perform(apply ? "start" : "save", async () => {
    if (!(await draft.save({ rule, existing }))) return { saved: false, applied: false };
    if (!apply) {
      toast("配置已保存，开启或应用后生效。", "success");
      return { saved: true, applied: true };
    }
    // Keep the new rule ID even if application fails, so retrying cannot create a duplicate rule.
    try { return { saved: true, applied: await applyLatest() }; }
    catch (error) { toast(`配置已保存，暂时无法应用：${error}`, "error"); return { saved: true, applied: false }; }
  });
  const start = (rule?: ForwardRule, oneTime?: string) => perform("start", async () => {
    if (rule && !rule.enabled && !(await draft.save({ rule: { ...rule, enabled: true }, existing: true }))) return false;
    return applyLatest(oneTime);
  });
  const stop = () => perform("stop", async () => {
    await invoke("ssh_tunnel_stop", { connectionId: conn.id });
    setSecret(""); await context.refetch();
    toast("手动转发已停止，配置已保留。", "success");
  });
  const remove = (id: string, apply: boolean) => perform("save", async () => {
    if (!(await draft.save({ removeId: id }))) return;
    if (!apply || await applyLatest()) toast("转发规则已删除。", "success");
  });
  const changeAuto = (auto: ForwardAuto) => {
    if (auto === draft.auto) return;
    return perform("auto", async () => {
      if (await draft.save({ auto })) toast("手动转发启动方式已更改。", "success");
    });
  };
  return { operation, busy: operation !== null, ready, secret, setSecret, saveRule, start, stop, remove, changeAuto };
}
