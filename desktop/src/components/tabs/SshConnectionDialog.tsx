import { useEffect, useState } from "react";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Icon } from "../ui/icon";
import type { SshConnection } from "../../lib/types";

interface Props {
  open: boolean;
  initial: SshConnection | null;
  onClose: () => void;
  onSaved: () => void;
}

const empty = (): SshConnection => ({
  id: "",
  name: "",
  host: "",
  port: 22,
  username: "",
  authType: "password",
  rememberPassword: false,
  encryptedPassword: "",
  keyPath: "",
  rememberPassphrase: false,
  encryptedPassphrase: "",
});

/**
 * 新建 / 编辑 SSH 连接弹框（首版密码登录）。
 * 密码仅「记住密码」时随 save 一并发往后端加密落盘；不记住时忽略，明文不出本弹框。
 */
export function SshConnectionDialog({ open, initial, onClose, onSaved }: Props) {
  const [form, setForm] = useState<SshConnection>(empty());
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [showPp, setShowPp] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial ? { ...initial } : empty());
      setPassword("");
      setShowPw(false);
      setPassphrase("");
      setShowPp(false);
    }
  }, [open, initial]);

  const set = <K extends keyof SshConnection>(k: K, v: SshConnection[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const valid =
    form.name.trim() !== "" &&
    form.host.trim() !== "" &&
    form.username.trim() !== "" &&
    form.port > 0 &&
    form.port <= 65535;

  const handleSave = async () => {
    if (!valid) {
      toast("请填写名称、主机、用户名，端口需在 1–65535", "error");
      return;
    }
    setSaving(true);
    try {
      await invoke("ssh_save_connection", {
        args: {
          connection: {
            ...form,
            name: form.name.trim(),
            host: form.host.trim(),
            username: form.username.trim(),
          },
          password:
            form.authType === "key" ? null : form.rememberPassword ? password : null,
          passphrase:
            form.authType === "key" && form.rememberPassphrase ? passphrase : null,
        },
      });
      onSaved();
      onClose();
    } catch (e) {
      toast(`保存失败：${e}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{initial ? "编辑 SSH 连接" : "新建 SSH 连接"}</DialogTitle>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
        >
          <Icon name="close" size={16} />
        </button>
      </DialogHeader>

      <div className="space-y-3.5">
        <Field label="名称">
          <Input
            value={form.name}
            placeholder="例如：生产服务器"
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="主机">
            <Input
              value={form.host}
              placeholder="192.168.1.10 或 example.com"
              onChange={(e) => set("host", e.target.value)}
            />
          </Field>
          <Field label="端口">
            <Input
              type="text"
              inputMode="numeric"
              value={String(form.port)}
              placeholder="22"
              onChange={(e) => {
                // 仅允许数字，过滤步进箭头与非数字输入；空值暂存 0，由 valid 拦截。
                const digits = e.target.value.replace(/[^0-9]/g, "");
                set("port", digits === "" ? 0 : parseInt(digits, 10));
              }}
            />
          </Field>
        </div>
        <Field label="用户名">
          <Input
            value={form.username}
            placeholder="root"
            onChange={(e) => set("username", e.target.value)}
          />
        </Field>

        <Field label="认证方式">
          <div className="flex items-center gap-2">
            {(["password", "key"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => set("authType", t as SshConnection["authType"])}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  form.authType === t
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-muted/40 text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "password" ? "密码" : "密钥"}
              </button>
            ))}
          </div>
        </Field>

        {form.authType === "key" ? (
          <>
            <Field label="私钥路径">
              <Input
                value={form.keyPath}
                placeholder="C:/Users/you/.ssh/id_rsa 或 /home/you/.ssh/id_rsa"
                onChange={(e) => set("keyPath", e.target.value)}
              />
            </Field>
            <Field label="密钥密码短语">
              <div className="relative">
                <Input
                  type={showPp ? "text" : "password"}
                  value={passphrase}
                  placeholder={
                    initial?.encryptedPassphrase
                      ? "（留空则保留已保存的密码短语）"
                      : "（无密码短语可留空）"
                  }
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPp((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <Icon name={showPp ? "eyeOff" : "eye"} size={16} />
                </button>
              </div>
            </Field>
            <label className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="text-sm">记住密码短语</span>
              <Switch
                checked={form.rememberPassphrase}
                onChange={(v: boolean) => set("rememberPassphrase", v)}
              />
            </label>
          </>
        ) : (
          <>
            <Field label="密码">
              <div className="relative">
                <Input
                  type={showPw ? "text" : "password"}
                  value={password}
                  placeholder={
                    initial?.encryptedPassword ? "（留空则保留已保存的密码）" : ""
                  }
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <Icon name={showPw ? "eyeOff" : "eye"} size={16} />
                </button>
              </div>
            </Field>
            <label className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="text-sm">记住密码</span>
              <Switch
                checked={form.rememberPassword}
                onChange={(v: boolean) => set("rememberPassword", v)}
              />
            </label>
            {initial?.encryptedPassword && !form.rememberPassword && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                ⚠️ 关闭「记住密码」并保存将清除本机已保存的密码，下次连接需手动输入。
              </p>
            )}
          </>
        )}

        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          🔒 密码/密码短语仅在「记住」时于本机加密存储（aes-gcm），明文只经本面板输入，绝不暴露给远程 Claude Code。
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
