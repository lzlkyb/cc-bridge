import { useId } from "react";
import { quoteRemotePath, type McpScope } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { ConnectProjectPath } from "./ConnectProjectPath";

export interface ConnectAutomation {
  busy: boolean;
  ready: boolean;
  configured: boolean;
  copyDisabled: boolean;
  disabled: boolean;
  label: string;
  message?: string;
  onStart: () => void;
  onCancel: () => void;
  cancelDisabled?: boolean;
  showNextStep?: boolean;
  onDismissNextStep?: () => void;
}

/** 连接命令与复制使用同一字符串，路径中的空格和 shell 字符不能改变命令含义。 */
export function ConnectCommand({ scope, command, transport, projectPath, setProjectPath, copied, onCopy, firstCallSeen, automation, showProjectPath = true }: {
  scope: McpScope; command: string; transport?: string; projectPath: string;
  setProjectPath: (path: string) => void; copied: boolean; onCopy: (command: string) => void; firstCallSeen: boolean;
  automation?: ConnectAutomation;
  showProjectPath?: boolean;
}) {
  const headingId = useId();
  const project = scope === "project";
  const path = projectPath.trim();
  const fullCommand = project && path && command ? `cd ${quoteRemotePath(path)} && ${command}` : command;
  return (
    <section className="connect-command" aria-labelledby={headingId}>
      <div className="connect-command-heading">
        <div>
          <div className="connect-section-heading"><h3 id={headingId}>{automation ? "完成接入" : "接入命令"}</h3>{!automation && <span className="connect-protocol">{transport === "sse" ? "SSE" : "HTTP"}</span>}</div>
          <p>{automation ? automation.ready ? "固定地址已配置完成，VPN 重连无需重新配置。" : `已选择${project ? "项目级" : "全局模式"}，点击一次即可自动完成配置。` : `SSH 登录远程服务器后，在${project ? "项目" : "任意"}目录中执行以下命令。`}</p>
        </div>
        <div className="stable-command-actions">
          {!automation && <Button type="button" onClick={() => onCopy(fullCommand)} disabled={!command} aria-live="polite"><Icon name={copied ? "check" : "copy"} size={14} />{copied ? "已复制" : "复制连接命令"}</Button>}
          {automation && <>
            {automation.busy && <Button type="button" variant="ghost" size="sm" disabled={automation.cancelDisabled} onClick={automation.onCancel}>取消</Button>}
            <Button type="button" isLoading={automation.busy} loadingText={automation.label} disabled={automation.disabled} onClick={automation.onStart}>
              <Icon name={automation.ready ? "check" : "plug"} size={14}/>{automation.label}
            </Button>
          </>}
        </div>
      </div>
      {project && showProjectPath && <ConnectProjectPath path={projectPath} onChange={setProjectPath} automatic={!!automation} disabled={automation?.busy} />}
      {automation?.message && <p className="stable-validation" role="alert">{automation.message}</p>}
      {automation?.showNextStep && <div className="connect-next-step" role="status"><Icon name="check" size={18}/><div><strong>配置完成，下一步打开 Claude Code</strong><p>请重新打开服务器上的 Claude Code，新的接入配置才会加载。</p></div>{automation.onDismissNextStep && <button type="button" className="stable-link" onClick={automation.onDismissNextStep}>收起提示</button>}</div>}
      {automation ? <details className="connect-command-details"><summary>查看连接命令<span>自动配置，无需手动执行</span></summary><Button type="button" size="sm" variant="outline" onClick={() => onCopy(fullCommand)} disabled={!command || automation.copyDisabled}><Icon name={copied ? "check" : "copy"} size={14}/>{copied ? "已复制" : "复制命令"}</Button><code className="connect-main-code">{fullCommand || "配置完成后显示实际生效的命令。"}</code><p className="connect-config-note">配置写入 <code>{project ? ".mcp.json" : "~/.claude.json"}</code>，网络恢复后沿用固定地址。</p></details> : <><code className="connect-main-code">{fullCommand || "正在生成连接命令…"}</code><p className="connect-config-note">配置将写入 <code>{project ? ".mcp.json" : "~/.claude.json"}</code>；执行后在{project ? "该项目" : "任意项目"}中启动 Claude Code。</p></>}
      {!automation && firstCallSeen && <p className="connect-first-call" role="status">✓ 已收到首次调用，配置生效</p>}
    </section>
  );
}
