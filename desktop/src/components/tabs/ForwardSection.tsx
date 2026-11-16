import { Icon } from "../ui/icon";
import type { ForwardKind, ForwardRule } from "../../lib/types";
import { FORWARD_PURPOSES, forwardAddress } from "../../lib/forwardPresentation";

/** Choose the usage device first; SSH flags remain in the editor's advanced settings. */
export function ForwardSection({ onChoose }: { onChoose: (kind: ForwardKind) => void }) {
  return <div className="fp-purpose-picker">
    <div className="fp-section-heading"><h2>你想让哪台设备访问服务？</h2><span>先选用途，再填端口</span></div>
    <div className="fp-purpose-options">{(["local", "remote"] as const).map(kind => <button key={kind} type="button" className="fp-purpose-option" onClick={() => onChoose(kind)}>
      <span className="fp-purpose-icon"><Icon name={FORWARD_PURPOSES[kind].icon} size={22} /></span>
      <span><strong>{FORWARD_PURPOSES[kind].label}</strong><small>{FORWARD_PURPOSES[kind].hint}</small></span><Icon name="arrowRight" size={17} />
    </button>)}</div>
    <button type="button" className="fp-text-button fp-other-purpose" onClick={() => onChoose("dynamic")}>其他用途：SOCKS5 代理<Icon name="chevronRight" size={13} /></button>
  </div>;
}

export function ForwardPath({ rule, boundPort }: { rule: ForwardRule; boundPort?: number | null }) {
  const meta = FORWARD_PURPOSES[rule.kind];
  const port = boundPort ?? rule.listenPort;
  return <div className="fp-flow-path" aria-label="访问路径">
    <div><span>{meta.accessMachine} · 访问入口</span><code>{port ? "端口 " + port : rule.kind === "remote" ? "开启后分配端口" : "等待填写端口"}</code></div>
    <Icon name="arrowRight" size={20} />
    <div><span>{meta.targetMachine} · 服务</span><code>{rule.kind === "dynamic" ? "SOCKS5 代理" : forwardAddress({ ...rule, listenHost: rule.targetHost, listenPort: rule.targetPort }) || "等待填写服务端口"}</code></div>
  </div>;
}
