import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import type { ForwardRule, TunnelStatus } from "../../lib/types";
import { FORWARD_GRID, ForwardRuleRow, type ForwardSide } from "./ForwardRuleRow";

/**
 * 按方向分成 C2S / S2C 两张表：方向由所在的表决定，每张表的列始终指同一台机器，
 * 不会出现「同一列在不同方向下指不同机器」的混淆。
 */
const META: Record<ForwardSide, { title: string; tag: string; desc: string; headers: string[] }> = {
  c2s: {
    title: "本机 → 服务器",
    tag: "C2S · -L / -D",
    desc: "在本机开端口，经服务器访问目标：服务器上的数据库、内网服务，或当 SOCKS5 代理用。目标地址是从服务器那边去访问的，填 127.0.0.1 就是服务器自己。",
    headers: ["本机监听地址", "本机端口", "类型", "目标地址（从服务器访问）", "目标端口", "备注", "状态"],
  },
  s2c: {
    title: "服务器 → 本机",
    tag: "S2C · -R",
    desc: "在服务器上开端口，连回本机的服务。服务器端口留空由服务器分配；监听 0.0.0.0 是否生效取决于服务器 sshd 的 GatewayPorts。",
    headers: ["服务器监听地址", "服务器端口", "本机目标地址", "本机目标端口", "备注", "状态"],
  },
};

export function ForwardSection({
  side,
  rules,
  running,
  onAdd,
  onChange,
  onRemove,
}: {
  side: ForwardSide;
  rules: ForwardRule[];
  running: TunnelStatus | undefined;
  onAdd: () => void;
  onChange: (id: string, patch: Partial<ForwardRule>) => void;
  onRemove: (id: string) => void;
}) {
  const m = META[side];
  return (
    <section className="rounded-lg border">
      <header className="flex items-start gap-3 border-b px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold">{m.title}</h3>
            <span className="text-[11px] text-muted-foreground">{m.tag}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{m.desc}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onAdd}><Icon name="plus" size={13} /> 添加</Button>
      </header>
      {rules.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">暂无规则</p>
      ) : (
        <div className="overflow-x-auto px-3 py-2">
          <div className="min-w-[720px] space-y-2">
            <div className={`${FORWARD_GRID[side]} text-[11px] text-muted-foreground`}>
              <span />
              {m.headers.map((h) => <span key={h} className="truncate" title={h}>{h}</span>)}
              <span />
            </div>
            {rules.map((r) => (
              <ForwardRuleRow key={r.id} side={side} rule={r} running={running} onChange={(p) => onChange(r.id, p)} onRemove={() => onRemove(r.id)} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
