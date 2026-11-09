import { useEffect, useId, useRef } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/icon";
import { SshAuthFields, Field } from "./SshAuthFields";
import { SshJumpField, SshConnectionRoute } from "./SshConnectionAdvanced";
import { useSshConnectionForm } from "./useSshConnectionForm";
import type { SshConnection } from "../../lib/types";
import type { SshOneTimeCredentials } from "../../lib/sshConnectionForm";
import "./ssh-connection.css";

interface Props {
  open: boolean;
  initial: SshConnection | null;
  connections: SshConnection[];
  onClose: () => void;
  onSaved: () => void;
  onConnect?: (connection: SshConnection, credentials: SshOneTimeCredentials) => void;
}

export function SshConnectionDialog(props: Props) {
  const id = useId();
  const { open, initial, connections, onConnect } = props;
  const { form, set, password, setPassword, passphrase, setPassphrase, status, close, save, revealCredential } = useSshConnectionForm(props);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (status.attempt) formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
  }, [status.attempt]);
  const inputProps = (key: "name" | "host" | "port" | "username") => ({
    id: `${id}-${key}`, "aria-invalid": !!status.errors[key],
    "aria-describedby": status.errors[key] ? `${id}-${key}-error` : undefined,
  });
  return <Modal open={open} onClose={() => close(true)} zIndex={50} ariaLabel={initial ? "编辑 SSH 连接" : "新建 SSH 连接"} className="modal-surface ssh-connection-dialog" overlayClassName="ssh-connection-overlay">
    <header className="ssh-connection-heading">
      <div className="ssh-connection-heading-title"><span className="ssh-connection-mark"><Icon name="server" size={23}/></span><div>
        <h2>{initial ? "编辑 SSH 连接" : "新建 SSH 连接"}</h2>
        <p>{status.restored ? "已恢复上次未完成的草稿" : "保存服务器信息，随时开始远程工作"}</p>
      </div></div>
      <button type="button" disabled={status.saving} onClick={() => close(true)} aria-label="关闭 SSH 连接设置" className="ssh-icon-button"><Icon name="close" size={17}/></button>
    </header>
    <form ref={formRef} className="ssh-connection-form" noValidate onSubmit={e => { e.preventDefault(); void save(!!onConnect); }}>
      <div className="ssh-connection-scroll">
        {status.error && <p className="ssh-form-error" role="alert">{status.error}</p>}
        <fieldset className="ssh-connection-columns" disabled={status.saving}>
          <section className="ssh-connection-column" aria-label="连接信息">
            <h3 className="ssh-section-title">连接信息</h3>
            <Field label="名称" htmlFor={`${id}-name`} error={status.errors.name}>
              <Input {...inputProps("name")} autoComplete="off" autoFocus value={form.name} placeholder="例如：公司开发服务器" onChange={e => set("name", e.target.value)}/>
            </Field>
            <div className="ssh-host-grid">
              <Field label="主机" htmlFor={`${id}-host`} error={status.errors.host}>
                <Input {...inputProps("host")} autoComplete="off" spellCheck={false} value={form.host} placeholder="IP 地址或域名" onChange={e => set("host", e.target.value)}/>
              </Field>
              <Field label="端口" htmlFor={`${id}-port`} error={status.errors.port}>
                <Input {...inputProps("port")} inputMode="numeric" value={form.port || ""} placeholder="22" onChange={e => set("port", Number(e.target.value.replace(/[^0-9]/g, "")))}/>
              </Field>
            </div>
            <Field label="用户名" htmlFor={`${id}-username`} error={status.errors.username}>
              <Input {...inputProps("username")} autoComplete="off" spellCheck={false} value={form.username} placeholder="例如：ubuntu" onChange={e => set("username", e.target.value)}/>
            </Field>
            <SshJumpField form={form} connections={connections} onChange={v => set("proxyJumpId", v)}/>
          </section>
          <section className="ssh-connection-column" aria-label="身份验证">
            <h3 className="ssh-section-title">身份验证</h3>
            <SshAuthFields key={`${initial?.id ?? "new"}-${open}`} form={form} set={set} initial={initial} password={password} setPassword={setPassword} passphrase={passphrase} setPassphrase={setPassphrase} onReveal={revealCredential} keyError={status.errors.keyPath}/>
            <SshConnectionRoute form={form} connections={connections}/>
          </section>
        </fieldset>
        <p className="ssh-security-note"><Icon name="lock" size={13}/><span>记住的凭据将在本机加密保存，仅供本机 SSH 使用。</span></p>
      </div>
      <footer className="ssh-connection-footer"><span>{initial ? "修改后保存生效" : "关闭后可继续填写"}</span><div>
        <Button type="button" variant="ghost" disabled={status.saving} onClick={() => close(false)}>取消</Button>
        <Button type="button" variant="outline" disabled={status.saving} onClick={() => void save(false)}>{status.saving ? "保存中…" : "保存"}</Button>
        {onConnect && <Button type="submit" disabled={status.saving}>保存并连接<Icon name="arrowRight" size={15}/></Button>}
      </div></footer>
    </form>
  </Modal>;
}
