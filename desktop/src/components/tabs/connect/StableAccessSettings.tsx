import { useState } from "react";
import type { StaticStatus } from "../../../lib/types";
import type { StableConnectState } from "../../../hooks/useStableConnect";
import type { StableAccessState } from "../../../hooks/useStableAccess";
import { buildStablePermissionCommand, stableScopeLabel } from "../../../lib/stableAccess";
import { useCopyFeedback } from "../../../hooks/useCopyFeedback";
import { useConnectionCopy } from "../../../hooks/useConnectionCopy";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { TokenManager } from "../TokenManager";
import { PermissionCard } from "./PermissionCard";
import { MultiDeviceToggle } from "./MultiDeviceToggle";

export function StableAccessSettings({ state, access, status, onRefresh, onStableUpdate }: {
  state: StableConnectState; access: StableAccessState; status?: StaticStatus; onRefresh: () => void; onStableUpdate?: () => void;
}) {
  const [includeShell, setIncludeShell] = useState(false);
  const commandCopy = useConnectionCopy(status);
  const target = state.compact ? state.record?.target : access.target;
  const scope = target ? target.scope === "user" ? "user" : "project" : state.compact ? state.record?.scope ?? "user" : access.scope;
  const path = target?.projectPath ?? (state.compact ? state.record?.projectPath ?? "" : access.project?.path ?? "");
  const multi = state.compact ? state.record?.multiDevice : access.multiDevice;
  const name = target?.name ?? (multi ? `cc-bridge-${status?.deviceId ?? ""}` : "cc-bridge");
  const file = target?.configFile ?? access.result?.files.find(proof => proof.scope === scope && proof.projectPath === path)?.configFile
    ?? (scope === "project" && path ? `${path}/.mcp.json` : "~/.claude.json");
  const sameTarget = state.compact || !!target && target.id === state.record?.target?.id;
  const permission = buildStablePermissionCommand(scope, path, includeShell, name);
  const copy = useCopyFeedback(2000, JSON.stringify([state.selectedId, target?.id, permission]));
  const otherProject = () => { state.update({ managing: true }); access.openProjects(); };
  return <details className="connect-advanced sc-advanced"><summary>更多设置<span>接入详情、Token 与权限</span></summary>
    <div className="connect-advanced-content"><dl className="sc-config-details"><div><dt>接入名称</dt><dd><code>{name}</code></dd></div><div><dt>生效范围</dt><dd>{stableScopeLabel(target?.scope ?? scope)}</dd></div><div><dt>配置位置</dt><dd><code>{scope === "project" && !path ? "选择项目后显示" : file}</code>{target?.scope === "local" && <small>沿用旧版项目条目，保留原有配置位置。</small>}</dd></div></dl>
      {!state.record?.configured && <fieldset disabled={state.busy || access.checking}><MultiDeviceToggle scope={scope} enabled={access.multiDevice} deviceId={status?.deviceId ?? ""} deviceName={status?.deviceName ?? ""} onToggle={access.setMultiDevice}/></fieldset>}
      {(target || state.record?.configured) && !state.busy && <button type="button" className="stable-link sc-other-project" onClick={otherProject}>接入其他项目<Icon name="arrowRight" size={13}/></button>}
      {state.record?.configured && state.command && sameTarget && <details className="connect-command-details"><summary>查看接入命令</summary><div className="code-box"><code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs">{state.command}</code><Button type="button" size="sm" variant="outline" disabled={state.busy || !state.record.configMatches} onClick={() => void commandCopy.copy("command", undefined, state.command)}>{commandCopy.isCopied("command") ? "已复制" : "复制命令"}</Button></div></details>}
      <fieldset disabled={state.busy} className="connect-support-grid"><TokenManager status={status ? { ...status, scope } : undefined} onRefresh={onRefresh} projectPath={path}
        onStableUpdate={onStableUpdate ?? (() => { state.update({ managing: true }); access.retry(); })}/>
        <PermissionCard scope={scope} projectPath={path} includeShellTools={includeShell} setIncludeShellTools={setIncludeShell} permissionCommand={permission} permCopied={copy.isCopied("permission")} handlePermCopy={() => copy.copy("permission", permission)}/></fieldset>
    </div>
  </details>;
}
