import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import type { ForwardAuto, ForwardRule, SshConnection, SshConnectionList } from "../../lib/types";

/** Editors keep their unsaved fields locally; this hook tracks only persisted connection settings. */
export function useForwardDraft(conn: SshConnection) {
  const queryClient = useQueryClient();
  const [rules, setRules] = useState<ForwardRule[]>(conn.forwards ?? []);
  const [auto, setAuto] = useState<ForwardAuto>(conn.forwardAuto ?? "ask");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setRules(conn.forwards ?? []); setAuto(conn.forwardAuto ?? "ask"); }, [conn.id, conn.forwards, conn.forwardAuto]);

  /** 保存失败已 toast，返回 false。 */
  const save = async (change: { rule?: ForwardRule; existing?: boolean; removeId?: string; auto?: ForwardAuto }): Promise<boolean> => {
    setSaving(true);
    try {
      // Update only the requested field on the latest record; another dialog may have changed the login or other rules.
      const list = await invoke<SshConnectionList>("ssh_list_connections");
      const current = list.connections.find(connection => connection.id === conn.id);
      if (!current) throw new Error("服务器连接已被移除，请重新选择。");
      let forwards = current.forwards ?? [];
      if (change.rule) {
        const exists = forwards.some(rule => rule.id === change.rule!.id);
        if (change.existing && !exists) throw new Error("这条转发已被删除，请重新添加。");
        forwards = exists ? forwards.map(rule => rule.id === change.rule!.id ? change.rule! : rule) : [...forwards, change.rule];
      }
      if (change.removeId) forwards = forwards.filter(rule => rule.id !== change.removeId);
      const updated = { ...current, forwards, forwardAuto: change.auto ?? current.forwardAuto ?? "ask" };
      // Null credentials retain the saved ciphertext; changing forwarding never writes the one-time password.
      await invoke("ssh_save_connection", {
        args: { connection: updated, password: null, passphrase: null },
      });
      setRules(forwards); setAuto(updated.forwardAuto);
      queryClient.setQueryData<SshConnectionList>(["sshConnections"], { ...list, connections: list.connections.map(connection => connection.id === conn.id ? updated : connection) });
      await queryClient.invalidateQueries({ queryKey: ["sshConnections"] });
      return true;
    } catch (e) {
      toast(`保存转发规则失败：${e}`, "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { rules, auto, saving, save };
}
