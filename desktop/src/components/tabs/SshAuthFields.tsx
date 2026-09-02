import { useState } from "react";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Icon } from "../ui/icon";
import type { SshConnection } from "../../lib/types";

interface Props {
  form: SshConnection;
  set: <K extends keyof SshConnection>(k: K, v: SshConnection[K]) => void;
  /** 编辑态的原连接（新建为 null）：用来判断库里是否已有密文。 */
  initial: SshConnection | null;
  password: string;
  setPassword: (v: string) => void;
  passphrase: string;
  setPassphrase: (v: string) => void;
}

/**
 * 连接弹框的「认证方式」整段（密码 / 密钥 + 对应的记住开关）。
 *
 * 从 `SshConnectionDialog` 拆出来：加入「跳板机」字段后那个文件会破 300 行硬上限
 * （规则 7）。这一段本来就自成一个单元：它是弹框里唯一碰明文凭据的地方。
 */
export function SshAuthFields({
  form,
  set,
  initial,
  password,
  setPassword,
  passphrase,
  setPassphrase,
}: Props) {
  const [showPw, setShowPw] = useState(false);
  const [showPp, setShowPp] = useState(false);

  return (
    <>
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
                placeholder={initial?.encryptedPassword ? "（留空则保留已保存的密码）" : ""}
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
    </>
  );
}

/** 弹框内的字段包装（小标题 + 控件）。与主弹框共用，避免两边各写一份。 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
