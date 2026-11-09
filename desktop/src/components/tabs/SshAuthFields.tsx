import { useEffect, useId, useRef, useState } from "react";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
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
  keyError?: string;
  /**
   * 向本机后端要一次已保存凭据的明文（`"password"` / `"passphrase"`）。
   * 失败时由调用方 toast 并返回 `null`——这里不做错误文案，避免两处措辞不一致。
   */
  onReveal: (field: "password" | "passphrase") => Promise<string | null>;
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
  onReveal, keyError,
}: Props) {
  const fieldId = useId();
  const generation = useRef(0);
  const [showPw, setShowPw] = useState(false);
  const [showPp, setShowPp] = useState(false);
  /** 正在解密哪一路（按钮置灰，防连点重复请求）。 */
  const [revealing, setRevealing] = useState<"password" | "passphrase" | null>(null);
  /**
   * 用户是否亲手改过这一格。
   *
   * 🔴 必须记：编辑态里用户把框清空 = 「我要换一个新密码」，此时点眼睛若还去
   * 后端取旧密码填回来，等于把他刚做的删除撤销掉。只有「一动没动过」才值得
   * 自动回填已保存的值。
   */
  const [pwDirty, setPwDirty] = useState(false);
  const [ppDirty, setPpDirty] = useState(false);

  // 切换认证方式时收起明文态：否则从密码页解锁后切到密钥页再切回来，
  // 密码框会直接是明文——用户上一次的「临时看一眼」变成了长期暴露。
  useEffect(() => {
    const token = ++generation.current;
    setShowPw(false);
    setShowPp(false);
    setRevealing(null);
    return () => { generation.current = token + 1; };
  }, [form.authType]);

  /** 取回明文 → 填进框 → 切明文态。失败时保持遮罩（调用方已提示）。 */
  const revealInto = async (
    field: "password" | "passphrase",
    apply: (v: string) => void,
    open: () => void,
  ) => {
    const token = generation.current;
    setRevealing(field);
    try {
      const plain = await onReveal(field);
      if (plain === null || token !== generation.current) return;
      apply(plain);
      open();
    } finally {
      if (token === generation.current) setRevealing(null);
    }
  };

  /**
   * 点眼睛：默认遮罩，点开才把明文取出来。
   *
   * 🔴 编辑态输入框**初始是空的**——`SshConnectionDialog` 只回填表单字段，
   * 库里存的是密文，前端没有明文。所以「只把 type 从 password 改成 text」
   * 等于什么都没发生：用户点了眼睛看不到密码，会以为功能坏了。
   * 要看到已保存的密码，必须按需向后端要一次解密。
   *
   * 框里已有值（新建态 / 用户刚输过）就不用问后端，直接切。
   */
  const togglePassword = () => {
    if (showPw) return setShowPw(false);
    if (password !== "" || !initial || pwDirty) return setShowPw(true);
    if (!initial.encryptedPassword) {
      // 编辑一条从没存过密码的连接：切明文也是空框，不如直接说清楚。
      toast("这条连接没有保存密码，直接输入即可", "info");
      return;
    }
    void revealInto("password", setPassword, () => setShowPw(true));
  };

  const togglePassphrase = () => {
    if (showPp) return setShowPp(false);
    if (passphrase !== "" || !initial || ppDirty) return setShowPp(true);
    if (!initial.encryptedPassphrase) {
      toast("这条连接没有保存密码短语，直接输入即可", "info");
      return;
    }
    void revealInto("passphrase", setPassphrase, () => setShowPp(true));
  };

  return (
    <>
      <div className="ssh-auth-choice"><Field label="认证方式">
        <div className="ssh-auth-tabs">
          {(["password", "key"] as const).map(t => <button key={t} type="button" aria-pressed={form.authType === t} onClick={() => set("authType", t)}>
            <Icon name={t === "password" ? "lock" : "key"} size={14}/>{t === "password" ? "密码" : "密钥"}
          </button>)}
        </div>
      </Field></div>

      <div className="ssh-auth-slot">{form.authType === "key" ? (
        <>
          <Field label="私钥路径" htmlFor={`${fieldId}-key`} error={keyError}>
            <div className="ssh-key-path">
            <Input
              id={`${fieldId}-key`}
              aria-invalid={!!keyError}
              aria-describedby={keyError ? `${fieldId}-key-error` : undefined}
              title={form.keyPath}
              value={form.keyPath}
              placeholder="选择或填写私钥路径"
              onChange={(e) => set("keyPath", e.target.value)}
            />
            <button type="button" className="ssh-key-picker" onClick={async () => {
              const token = generation.current;
              try {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const path = await open({ title: "选择 SSH 私钥", multiple: false, directory: false });
                if (typeof path === "string" && generation.current === token) set("keyPath", path);
              } catch (e) { toast(`选择私钥失败：${e}`, "error"); }
            }}><Icon name="folder" size={15}/>选择文件</button>
            </div>
          </Field>
          <Field label="密钥密码短语" htmlFor={`${fieldId}-passphrase`}>
            <div className="relative">
              <Input
                id={`${fieldId}-passphrase`}
                type={showPp ? "text" : "password"}
                value={passphrase}
                placeholder={
                  initial?.encryptedPassphrase
                    ? "已保存密码短语"
                    : "（无密码短语可留空）"
                }
                onChange={(e) => {
                  generation.current++;
                  setRevealing(null);
                  setPpDirty(true);
                  setPassphrase(e.target.value);
                }}
                className="pr-9"
              />
              <button
                type="button"
                aria-label={showPp ? "隐藏密码短语" : "显示密码短语"}
                aria-pressed={showPp}
                disabled={revealing === "passphrase"}
                onClick={togglePassphrase}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <Icon name={showPp ? "eyeOff" : "eye"} size={16} />
              </button>
            </div>
          </Field>
          {initial?.encryptedPassphrase && form.authType === "key" && <p className="ssh-field-help">留空保留已保存的密码短语；点眼睛可查看。</p>}

        </>
      ) : (
        <>
          <Field label="密码" htmlFor={`${fieldId}-password`}>
            <div className="relative">
              <Input
                id={`${fieldId}-password`}
                type={showPw ? "text" : "password"}
                value={password}
                placeholder={
                  initial?.encryptedPassword ? "已保存密码" : ""
                }
                onChange={(e) => {
                  generation.current++;
                  setRevealing(null);
                  setPwDirty(true);
                  setPassword(e.target.value);
                }}
                className="pr-9"
              />
              <button
                type="button"
                aria-label={showPw ? "隐藏密码" : "显示密码"}
                aria-pressed={showPw}
                disabled={revealing === "password"}
                onClick={togglePassword}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <Icon name={showPw ? "eyeOff" : "eye"} size={16} />
              </button>
            </div>
          </Field>
          {initial?.encryptedPassword && <p className="ssh-field-help">留空保留已保存的密码；点眼睛可查看。</p>}

        </>
      )}</div>
      {form.authType === "key" ? <>
          <label className="ssh-remember-row">
            <span>在此设备记住密码短语<small>{initial?.encryptedPassphrase && !form.rememberPassphrase ? "保存后清除已保存的密码短语，下次连接需输入" : "关闭时，仅供本次连接使用"}</small></span>
            <Switch
              ariaLabel="记住密码短语"
              checked={form.rememberPassphrase}
              onChange={(v: boolean) => set("rememberPassphrase", v)}
            />
          </label>
      </> : <>
          <label className="ssh-remember-row">
            <span>在此设备记住密码<small>{initial?.encryptedPassword && !form.rememberPassword ? "保存后清除已保存的密码，下次连接需输入" : "关闭时，仅供本次连接使用"}</small></span>
            <Switch
              ariaLabel="记住密码"
              checked={form.rememberPassword}
              onChange={(v: boolean) => set("rememberPassword", v)}
            />
          </label>
      </>}
    </>
  );
}

/** 弹框内的字段包装（小标题 + 控件）。与主弹框共用，避免两边各写一份。 */
export function Field({ label, htmlFor, children, error }: { label: string; htmlFor?: string; children: React.ReactNode; error?: string }) {
  return (
    <div className="ssh-field" role={htmlFor ? undefined : "group"} aria-label={htmlFor ? undefined : label}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      ) : (
        <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      )}
      {children}
      {(htmlFor || error) && <p id={htmlFor ? `${htmlFor}-error` : undefined} className="ssh-field-error" role={error ? "alert" : undefined}>{error}</p>}
    </div>
  );
}
