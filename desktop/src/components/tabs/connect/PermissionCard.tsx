import { McpScope } from "../../../lib/utils";
import { Alert } from "../../ui/alert";
import { Icon } from "../../ui/icon";
import { Switch } from "../../ui/switch";
import { CommandBlock } from "./widgets";

/**
 * 权限自动授权卡（从 ConnectTab 抽离）：Claude Code 的 mcp__cc-bridge__* 免弹窗命令。
 * 仅 claude-code 路径使用（P2-3 后其余工具无此概念，由 ToolGuide 分流）。
 */
export function PermissionCard({
  scope,
  projectPath,
  includeShellTools,
  setIncludeShellTools,
  permissionCommand,
  permCopied,
  handlePermCopy,
}: {
  scope: McpScope;
  projectPath: string;
  includeShellTools: boolean;
  setIncludeShellTools: (v: boolean) => void;
  permissionCommand: string;
  permCopied: boolean;
  handlePermCopy: () => void;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div className="s-sec-label">权限自动授权</div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        复制命令到远端终端执行一次，即可免去 Claude Code 对 cc-bridge 全部工具的重复授权。
      </p>
      {scope === "project" && !projectPath.trim() && (
        <Alert variant="warning" className="flex items-start gap-2 p-3 text-xs">
          <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
          <span>上方路径未填写——命令不带 <code className="rounded bg-background px-1">cd</code>，写错位置不会报错。</span>
        </Alert>
      )}
      <div className="s-row">
        <div className="min-w-0 flex-1">
          <p className="s-label">同时免确认命令执行工具</p>
          <p className="s-row-desc mt-0.5">
            开启后 <code className="rounded bg-muted px-1">run_command</code> 等命令类工具也免确认。
          </p>
        </div>
        <Switch checked={includeShellTools} onChange={setIncludeShellTools} variant="danger" ariaLabel="同时免确认命令执行工具" />
      </div>
      {includeShellTools && (
        <Alert variant="destructive" className="flex items-start gap-2 p-3 text-xs">
          <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">已开启：生成的命令会免确认全部 19 个工具（含命令执行）。请仅在完全信任该连接时开启。</span>
        </Alert>
      )}
      <CommandBlock command={permissionCommand} copied={permCopied} onCopy={handlePermCopy} />
    </div>
  );
}
