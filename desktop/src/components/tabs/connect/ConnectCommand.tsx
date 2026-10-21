import { useId } from "react";
import { quoteRemotePath, type McpScope } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";

/** 连接命令与复制使用同一字符串，路径中的空格和 shell 字符不能改变命令含义。 */
export function ConnectCommand({ scope, command, transport, projectPath, setProjectPath, copied, onCopy, firstCallSeen }: {
  scope: McpScope; command: string; transport?: string; projectPath: string;
  setProjectPath: (path: string) => void; copied: boolean; onCopy: (command: string) => void; firstCallSeen: boolean;
}) {
  const headingId = useId();
  const pathId = useId();
  const hintId = useId();
  const project = scope === "project";
  const path = projectPath.trim();
  const fullCommand = project && path && command ? `cd ${quoteRemotePath(path)} && ${command}` : command;
  return (
    <section className="connect-command" aria-labelledby={headingId}>
      <div className="connect-command-heading">
        <div>
          <div className="connect-section-heading"><h3 id={headingId}>接入命令</h3><span className="connect-protocol">{transport === "sse" ? "SSE" : "HTTP"}</span></div>
          <p>SSH 登录远程服务器后，{project ? "在项目目录中" : "在任意目录中"}执行以下命令。</p>
        </div>
        <Button type="button" onClick={() => onCopy(fullCommand)} disabled={!command} aria-live="polite">
          <Icon name={copied ? "check" : "copy"} size={14} />{copied ? "已复制" : "复制连接命令"}
        </Button>
      </div>
      {project && (
        <div className="connect-path">
          <label htmlFor={pathId}>远程项目路径 <span>可选</span></label>
          <input id={pathId} aria-describedby={hintId} value={projectPath} onChange={e => setProjectPath(e.target.value)} placeholder="/home/user/my-project" />
          <p id={hintId}>{path ? "已将路径合并到下方命令，复制后可直接执行。" : "留空时，请先在远程终端 cd 到项目目录。"}</p>
        </div>
      )}
      <code className="connect-main-code">{fullCommand || "正在生成连接命令…"}</code>
      <p className="connect-config-note">配置将写入 <code>{project ? ".mcp.json" : "~/.claude.json"}</code>；执行后在{project ? "该项目" : "任意项目"}中启动 Claude Code。</p>
      {firstCallSeen && <p className="connect-first-call" role="status">✓ 已收到首次调用，配置生效</p>}
    </section>
  );
}
