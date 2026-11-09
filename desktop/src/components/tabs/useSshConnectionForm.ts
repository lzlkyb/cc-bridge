import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { emptySshConnection, validateSshConnection, type SshFieldErrors, type SshOneTimeCredentials } from "../../lib/sshConnectionForm";
import type { SshConnection } from "../../lib/types";
import { toast } from "../ui/toast";

interface Props {
  open: boolean; initial: SshConnection | null; onClose: () => void; onSaved: () => void;
  onConnect?: (connection: SshConnection, credentials: SshOneTimeCredentials) => void;
}
// Memory only: accidental dismissal should not discard a newly entered connection.
let draft: { form: SshConnection; password: string; passphrase: string } | null = null;

export function useSshConnectionForm({ open, initial, onClose, onSaved, onConnect }: Props) {
  const [form, setForm] = useState(emptySshConnection);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState({ saving: false, error: "", errors: {} as SshFieldErrors, restored: false, attempt: 0 });
  const busy = useRef(false);
  useEffect(() => {
    setForm(initial ? { ...initial } : draft ? { ...draft.form } : emptySshConnection());
    setPassword(open && !initial ? draft?.password ?? "" : "");
    setPassphrase(open && !initial ? draft?.passphrase ?? "" : "");
    setStatus({ saving: false, error: "", errors: {}, restored: open && !initial && !!draft, attempt: 0 });
  }, [open, initial]);
  const set = <K extends keyof SshConnection>(key: K, value: SshConnection[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setStatus(prev => ({ ...prev, errors: { ...prev.errors, [key]: undefined }, error: "" }));
  };
  const close = (keepDraft: boolean) => {
    if (busy.current) return;
    if (!initial) draft = keepDraft ? { form, password, passphrase } : null;
    setPassword(""); setPassphrase(""); onClose();
  };
  const revealCredential = async (field: "password" | "passphrase") => {
    if (!initial) return null;
    try { return await invoke<string>("ssh_reveal_credential", { id: initial.id, field }); }
    catch (e) { toast(`无法显示已保存的${field === "password" ? "密码" : "密码短语"}：${e}`, "error"); return null; }
  };
  const save = async (connect = false) => {
    if (busy.current) return;
    const errors = validateSshConnection(form);
    setStatus(prev => ({ ...prev, errors, error: "", attempt: prev.attempt + 1 }));
    if (Object.keys(errors).length) return;
    busy.current = true;
    setStatus(prev => ({ ...prev, saving: true }));
    let saved: SshConnection;
    try {
      saved = await invoke<SshConnection>("ssh_save_connection", { args: {
        connection: { ...form, name: form.name.trim(), host: form.host.trim(), username: form.username.trim(), keyPath: form.keyPath.trim() },
        password: form.authType !== "key" && form.rememberPassword ? password : null,
        passphrase: form.authType === "key" && form.rememberPassphrase ? passphrase : null,
      } });
    } catch (e) {
      setStatus(prev => ({ ...prev, saving: false, error: `保存失败：${e}` }));
      busy.current = false; return;
    }
    const credentials: SshOneTimeCredentials = form.authType === "key"
      ? (passphrase ? { passphrase } : {}) : (password ? { password } : {});
    draft = null; busy.current = false;
    setPassword(""); setPassphrase("");
    setStatus(prev => ({ ...prev, saving: false }));
    onSaved(); onClose();
    if (connect && onConnect) onConnect(saved, credentials);
    else toast("连接配置已保存", "success");
  };
  return { form, set, password, setPassword, passphrase, setPassphrase, status, close, save, revealCredential };
}
