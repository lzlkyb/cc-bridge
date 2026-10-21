import { useId, useState } from "react";
import type { McpScope } from "../../../lib/utils";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { Switch } from "../../ui/switch";
import { CommandBlock } from "./widgets";

/** 复制入口始终可见；长脚本的查看状态不会收起其他操作。 */
export function PermissionCard({ scope, projectPath, includeShellTools, setIncludeShellTools, permissionCommand, permCopied, handlePermCopy }: {
  scope: McpScope; projectPath: string; includeShellTools: boolean;
  setIncludeShellTools: (value: boolean) => void; permissionCommand: string; permCopied: boolean; handlePermCopy: () => void;
}) {
  const [showScript, setShowScript] = useState(false);
  const headingId = useId();
  const scriptId = useId();
  return (
    <section className="connect-permission" aria-labelledby={headingId}>
      <div className="connect-section-heading"><h3 id={headingId}>权限自动授权</h3><span className="connect-optional">可选</span></div>
      <p className="connect-support-desc">执行后可减少 Claude Code 对文件工具的重复确认。</p>
      <div className="connect-permission-switch">
        <div><p className="connect-switch-label">命令执行工具也免确认</p><p>开启后将扩大免确认范围，请谨慎选择。</p></div>
        <Switch checked={includeShellTools} onChange={setIncludeShellTools} variant="danger" ariaLabel="命令执行工具也免确认" />
      </div>
      {includeShellTools && <Alert variant="destructive" className="my-2 text-xs" role="status">包含命令执行：仅在完全信任此连接时使用。</Alert>}
      {scope === "project" && !projectPath.trim() && <p className="connect-path-note">项目路径未填写，请先进入正确项目目录再执行。</p>}
      <p className="connect-permission-target">写入 <code>{scope === "project" ? ".claude/settings.local.json" : "~/.claude/settings.json"}</code></p>
      <div className="connect-permission-actions">
        <Button type="button" size="sm" variant="outline" onClick={handlePermCopy} disabled={!permissionCommand} aria-live="polite">
          <Icon name={permCopied ? "check" : "copy"} size={13} />{permCopied ? "已复制" : "复制授权命令"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setShowScript(!showScript)} aria-expanded={showScript} aria-controls={scriptId}>
          {showScript ? "收起脚本" : "查看完整脚本"}<Icon name={showScript ? "chevronUp" : "chevronDown"} size={12} />
        </Button>
      </div>
      {showScript && <div id={scriptId} className="connect-permission-script"><CommandBlock command={permissionCommand} copied={permCopied} onCopy={handlePermCopy} /></div>}
    </section>
  );
}
