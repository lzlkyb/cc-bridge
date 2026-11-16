import { useId, type ReactNode } from "react";
import type { StaticStatus } from "../../../lib/types";
import type { ConnectGuideState } from "../../../hooks/useConnectGuideState";
import { OptionCard } from "./widgets";
import { ConnectCommand, type ConnectAutomation } from "./ConnectCommand";
import { TokenManager } from "../TokenManager";
import { PermissionCard } from "./PermissionCard";
import { ConnectProjectPath } from "./ConnectProjectPath";
import "./connect-guide.css";

/**
 * Claude Code 专属的接入步骤。稳定连接突出自动接入，手动设置按需展开。
 * 地址卡片（AddressPicker）不在这里：它对四种工具都需要，由 ConnectTab 经
 * ToolGuide 的 `common` 插槽渲染（见那里的注释）。
 */
export function ConnectGuide({ status, guide, onRefresh, stableCommand, automation, advancedControls }: {
  status?: StaticStatus; guide: ConnectGuideState; onRefresh: () => void; stableCommand?: string; automation?: ConnectAutomation;
  advancedControls?: ReactNode;
}) {
  const scopeId = useId();
  const scopeOptions = <fieldset disabled={automation?.busy} aria-labelledby={scopeId} className="min-w-0">
        <div className="connect-section-heading"><h3 id={scopeId}>接入模式</h3><span>{guide.multiDevice ? "多设备接入固定使用全局模式" : "选择配置的生效范围"}</span></div>
        {guide.multiDevice ? <p className="connect-mode-note">全局模式 · 每台电脑使用独立条目，所有项目均可使用。</p> : (
          <div className="connect-choice-grid">
            <OptionCard selected={guide.scope === "project"} title="项目级" badge={automation ? undefined : "推荐"} desc="仅指定项目生效" onClick={() => guide.setScope("project")} />
            <OptionCard selected={guide.scope === "user"} title="全局模式" badge={automation ? "推荐" : undefined} desc="一次配置，所有项目都能使用" onClick={() => guide.setScope("user")} />
          </div>
        )}
      </fieldset>;
  const support = <fieldset disabled={automation?.busy} className="connect-support-grid min-w-0">
    <TokenManager status={status} onRefresh={onRefresh} projectPath={guide.projectPath} />
    <PermissionCard scope={guide.scope} projectPath={guide.projectPath}
      includeShellTools={guide.includeShellTools} setIncludeShellTools={guide.setIncludeShellTools}
      permissionCommand={guide.permissionCommand} permCopied={guide.isCopied("perm")} handlePermCopy={guide.copyPerm} />
  </fieldset>;
  return <div className="connect-guide">
      {!automation && scopeOptions}
      <ConnectCommand scope={guide.scope} command={stableCommand ?? guide.connectCommand} transport={status?.transport}
        projectPath={guide.projectPath} setProjectPath={guide.setProjectPath}
        copied={guide.isCopied("connect")} onCopy={guide.copyConnect} firstCallSeen={guide.firstCallSeen} automation={automation} showProjectPath={!automation} />
      {automation ? <details className="connect-advanced" open={guide.scope === "project"}>
        <summary>更多设置<span>{guide.multiDevice ? "多设备 · 全局模式" : guide.scope === "project" ? "项目级" : "全局模式 · 所有项目可用"}</span></summary>
        <div className="connect-advanced-content">
          {advancedControls && <fieldset disabled={automation.busy} className="connect-advanced-devices">{advancedControls}</fieldset>}
          {scopeOptions}
          {guide.scope === "project" && <ConnectProjectPath path={guide.projectPath} onChange={guide.setProjectPath} automatic disabled={automation.busy}/>}
          {support}
        </div>
      </details> : support}
  </div>;
}
