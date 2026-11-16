import { Icon } from "../../components/ui/icon";
import { scopeLabel, type BridgeEntry } from "./discovery";

export function ConnectionTargets({ entries, onChoose, onClose }: { entries: BridgeEntry[]; onChoose: (id: string) => void; onClose?: () => void }) {
  const uncertain = entries.length === 1 && !entries[0].recognized;
  return <section className="sc-picker" aria-label="选择已有接入">
    <div className="sc-picker-heading"><div><h3>{uncertain ? "这是你之前接入的桥吗？" : "选择要升级的接入"}</h3><p>{uncertain ? "这个名称与常见配置不同，请先核对地址。" : "找到多个接入，请选择这次要升级的项目或范围。"}</p></div>{onClose && <button className="qc-link sc-muted-link" aria-label="关闭接入选择" onClick={onClose}><Icon name="close" size={16}/></button>}</div>
    <div className="sc-project-list">{entries.map(entry => <button type="button" key={entry.id} className="sc-project-row sc-entry-row" onClick={() => onChoose(entry.id)}><Icon name={entry.scope === "user" ? "globe" : "folder"} size={18}/><span><b>{entry.title}{entry.scope !== "user" && <em>{scopeLabel(entry.scope)}</em>}</b><small>{entry.projectPath || "一次接入，在所有项目中使用"}</small><code>{entry.name} · {entry.url}</code></span><span className="sc-entry-action">{uncertain ? "是，升级此接入" : "选择"}<Icon name="arrowRight" size={14}/></span></button>)}</div>
  </section>;
}
