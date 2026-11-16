import { useId } from "react";
import type { StableConnectState } from "../../../hooks/useStableConnect";
import { Button } from "../../ui/button";

export function StableLogin({ state, onSubmit, busy = false }: { state: StableConnectState; onSubmit: () => void; busy?: boolean }) {
  const id = useId();
  const keyAuth = state.connection?.authType === "key";
  return <form className="sc-login" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <label htmlFor={id}>{keyAuth ? "密钥口令" : "服务器登录密码"}</label>
    <div><input id={id} type="password" autoComplete="off" value={(keyAuth ? state.ui.credentials.passphrase : state.ui.credentials.password) ?? ""}
      onChange={event => state.update({ credentials: keyAuth ? { passphrase: event.target.value } : { password: event.target.value } })}
      disabled={busy} placeholder={keyAuth ? "输入密钥口令" : "输入服务器登录密码"}/>
      <Button type="submit" size="sm" disabled={busy} isLoading={busy} loadingText="正在检查…">登录并检查</Button></div>
    <p>登录信息仅用于本次应用运行期间的连接与重连。</p>
    <button type="button" className="stable-link" disabled={busy} onClick={() => state.update({ dialog: true, editing: true })}>编辑登录信息</button>
  </form>;
}
