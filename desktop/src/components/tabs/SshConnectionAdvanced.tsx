import { Combobox } from "../ui/combobox";
import { Icon } from "../ui/icon";
import { Field } from "./SshAuthFields";
import type { SshConnection } from "../../lib/types";

export function SshJumpField({ form, connections, onChange }: { form: SshConnection; connections: SshConnection[]; onChange: (id: string) => void }) {
  const options = [{ value: "", label: "不使用（直连）" }, ...connections.map(c => ({
    value: c.id, label: c.name || c.host,
    hint: c.id === form.id ? "不能选自己" : c.proxyJumpId ? "已配跳板，不可再作跳板" : `${c.username}@${c.host}:${c.port}`,
    disabled: c.id === form.id || !!c.proxyJumpId,
  }))];
  return <div className="ssh-jump-field"><Field label="跳板机"><Combobox className="ssh-jump-combobox" ariaLabel={`跳板机：${options.find(o => o.value === form.proxyJumpId)?.label ?? form.proxyJumpId}`} fullWidth value={form.proxyJumpId} options={options} onChange={onChange}/></Field></div>;
}

export function SshConnectionRoute({ form, connections }: { form: SshConnection; connections: SshConnection[] }) {
  const jump = connections.find(c => c.id === form.proxyJumpId);
  return <div className="ssh-route-section"><p>连接路径</p><div className="ssh-connection-route"><span>本机</span><Icon name="arrowRight" size={13}/>{form.proxyJumpId && <><b title={jump?.name}>{jump?.name || "跳板机已不存在"}</b><Icon name="arrowRight" size={13}/></>}<b title={form.host}>{form.host || "目标服务器"}</b></div></div>;
}
