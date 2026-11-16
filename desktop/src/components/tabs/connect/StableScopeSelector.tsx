import type { StableAccessState } from "../../../hooks/useStableAccess";
import { stableTargetTitle } from "../../../lib/stableAccess";
import { Icon } from "../../ui/icon";

export function StableScopeSelector({ access, busy }: { access: StableAccessState; busy: boolean }) {
  const { target, project, scope, scopeEditing, scopeChanged } = access;
  const impact = !scopeChanged ? "选择新的使用范围，应用后生效。" : scope === "user"
    ? "原项目接入将移到全局，之后所有项目都可以使用。"
    : !project ? "选择项目后，原全局接入将移到所选项目。"
    : target?.scope === "user" ? `原全局接入将移到「${project.name}」，之后仅在此项目使用。`
    : `「${target ? stableTargetTitle(target) : "原项目"}」的接入将移到「${project.name}」，原项目将不再使用此接入。`;
  return <fieldset className="sc-scope" disabled={busy}><legend>在哪里使用桥？</legend>
    <div role="group" aria-label="接入生效范围">
      <button type="button" aria-pressed={scope === "project"} onClick={() => access.chooseScope("project")}><Icon name="folder" size={17}/><span><b>只在一个项目使用<em>推荐</em></b><small>从服务器上选择项目文件夹</small></span><Icon name={scope === "project" ? "check" : "chevronRight"} size={15}/></button>
      <button type="button" aria-pressed={scope === "user"} onClick={() => access.chooseScope("user")}><Icon name="globe" size={17}/><span><b>所有项目都可用</b><small>配置一次，不用选择文件夹</small></span><Icon name={scope === "user" ? "check" : "chevronRight"} size={15}/></button>
    </div>
    {scope === "project" && <button type="button" className="sc-selected-project sc-project-row" onClick={access.openProjects}><Icon name="folder" size={17}/><span><b>{project?.name ?? "请选择服务器上的项目"}</b>{project && <small>{project.path}</small>}</span><span>{project ? "更换项目" : "选择项目"}<Icon name="chevronDown" size={13}/></span></button>}
    {scopeEditing && <p className="sc-scope-impact" role="status">{impact}{scopeChanged && " 接入名称保留，继续使用固定地址。"}</p>}
  </fieldset>;
}
