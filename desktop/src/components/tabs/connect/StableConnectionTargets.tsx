import { Icon } from "../../ui/icon";
import { stableScopeLabel, stableTargetTitle, type StableTarget } from "../../../lib/stableAccess";

export function StableConnectionTargets({ entries, onChoose, onOtherProject, onClose }: {
  entries: StableTarget[]; onChoose: (id: string) => void; onOtherProject?: () => void; onClose?: () => void;
}) {
  const uncertain = entries.length === 1 && !entries[0].recognized;
  return <section className="sc-picker" aria-label="选择已有接入">
    <div className="sc-picker-heading"><div><h3>{uncertain ? "这是你之前接入的桥吗？" : "选择要升级的接入"}</h3><p>{uncertain ? "这个名称与常见配置不同，请先核对地址。" : "找到多个接入，请选择这次要升级的项目或范围。"}</p></div>{onClose && <button type="button" className="stable-link sc-muted-link" aria-label="关闭接入选择" onClick={onClose}><Icon name="close" size={16}/></button>}</div>
    <div className="sc-project-list">{entries.map(entry => <button type="button" key={entry.id} className="sc-project-row sc-entry-row" onClick={() => onChoose(entry.id)}><Icon name={entry.scope === "user" ? "globe" : "folder"} size={18}/><span><b>{stableTargetTitle(entry)}{entry.scope !== "user" && <em>{stableScopeLabel(entry.scope)}</em>}</b><small>{entry.projectPath || "一次接入，在所有项目中使用"}</small><code>{entry.name} · {entry.url}</code></span><span className="sc-entry-action">{uncertain ? "是，升级此接入" : "选择"}<Icon name="arrowRight" size={14}/></span></button>)}</div>
    {onOtherProject && <button type="button" className="stable-link sc-other-project" onClick={onOtherProject}>接入其他项目<Icon name="arrowRight" size={13}/></button>}
  </section>;
}
