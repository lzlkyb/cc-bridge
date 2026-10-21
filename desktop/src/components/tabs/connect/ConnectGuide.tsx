import { useId } from "react";
import type { StaticStatus } from "../../../lib/types";
import type { ConnectGuideState } from "../../../hooks/useConnectGuideState";
import { AddressPicker } from "./AddressPicker";
import { OptionCard } from "./widgets";
import { ConnectCommand } from "./ConnectCommand";
import { TokenManager } from "../TokenManager";
import { PermissionCard } from "./PermissionCard";
import "./connect-guide.css";

/** 主要操作常驻；只有较长的授权脚本按需查看，避免配置时来回展开。 */
export function ConnectGuide({ status, guide, listenAll, lanIps, selectedIp, onSelectIp, onRefresh, onCopySed }: {
  status?: StaticStatus; guide: ConnectGuideState; listenAll: boolean; lanIps: string[];
  selectedIp: string; onSelectIp: (ip: string) => void; onRefresh: () => void;
  onCopySed?: () => boolean | Promise<boolean>;
}) {
  const scopeId = useId();
  return <>
    {listenAll && lanIps.length > 0 && <AddressPicker ips={lanIps} selected={selectedIp} onSelect={onSelectIp}
      healthCheck={guide.healthCheck} port={guide.port} onRefresh={onRefresh} onCopySed={onCopySed} />}
    <div className="connect-guide">
      <section aria-labelledby={scopeId}>
        <div className="connect-section-heading"><h3 id={scopeId}>接入模式</h3><span>{guide.multiDevice ? "多设备接入固定使用全局模式" : "选择配置的生效范围"}</span></div>
        {guide.multiDevice ? <p className="connect-mode-note">全局模式 · 每台电脑使用独立条目，所有项目均可使用。</p> : (
          <div className="connect-choice-grid">
            <OptionCard selected={guide.scope === "project"} title="项目级" badge="推荐" desc="仅指定项目生效" onClick={() => guide.setScope("project")} />
            <OptionCard selected={guide.scope === "user"} title="全局模式" desc="一次配置，所有项目都能使用" onClick={() => guide.setScope("user")} />
          </div>
        )}
      </section>
      <ConnectCommand scope={guide.scope} command={guide.connectCommand} transport={status?.transport}
        projectPath={guide.projectPath} setProjectPath={guide.setProjectPath}
        copied={guide.isCopied("connect")} onCopy={guide.copyConnect} firstCallSeen={guide.firstCallSeen} />
      <div className="connect-support-grid">
        <TokenManager status={status} onRefresh={onRefresh} projectPath={guide.projectPath} />
        <PermissionCard scope={guide.scope} projectPath={guide.projectPath}
          includeShellTools={guide.includeShellTools} setIncludeShellTools={guide.setIncludeShellTools}
          permissionCommand={guide.permissionCommand} permCopied={guide.isCopied("perm")} handlePermCopy={guide.copyPerm} />
      </div>
    </div>
  </>;
}
