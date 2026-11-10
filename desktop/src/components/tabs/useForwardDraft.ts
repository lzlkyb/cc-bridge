import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import type { ForwardAuto, ForwardKind, ForwardRule, SshConnection } from "../../lib/types";

/** 目标地址留空：输入框的提示会说明 127.0.0.1 指哪台机器，预填反而把提示盖掉。 */
export const newForwardRule = (kind: ForwardKind): ForwardRule => ({
  id: crypto.randomUUID(),
  enabled: true,
  kind,
  listenHost: "127.0.0.1",
  listenPort: 0,
  targetHost: "",
  targetPort: 0,
  note: "",
});

/**
 * 转发规则草稿：表格里的改动只是草稿，点「保存」才写进连接配置，
 * 「保存并应用」才会重启转发进程。
 *
 * 草稿只在挂载时取一次：调用方按 `key={conn.id}` 换连接就重挂。保存后列表重拉给出的
 * 新对象内容就是刚存的草稿，不需要同步回来。
 */
export function useForwardDraft(conn: SshConnection) {
  const queryClient = useQueryClient();
  const [rules, setRules] = useState<ForwardRule[]>(conn.forwards ?? []);
  const [auto, setAuto] = useState<ForwardAuto>(conn.forwardAuto ?? "ask");
  const [saving, setSaving] = useState(false);

  const dirty = auto !== (conn.forwardAuto ?? "ask") || JSON.stringify(rules) !== JSON.stringify(conn.forwards ?? []);

  const update = (id: string, patch: Partial<ForwardRule>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = (kind: ForwardKind) => setRules((rs) => [...rs, newForwardRule(kind)]);
  const remove = (id: string) => setRules((rs) => rs.filter((r) => r.id !== id));

  /** 保存失败已 toast，返回 false。 */
  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      // password/passphrase 给 null：后端保留已存的密文，不会把记住的密码冲掉。
      await invoke("ssh_save_connection", {
        args: { connection: { ...conn, forwards: rules, forwardAuto: auto }, password: null, passphrase: null },
      });
      await queryClient.invalidateQueries({ queryKey: ["sshConnections"] });
      return true;
    } catch (e) {
      toast(`保存转发规则失败：${e}`, "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { rules, auto, setAuto, dirty, saving, update, add, remove, save };
}
