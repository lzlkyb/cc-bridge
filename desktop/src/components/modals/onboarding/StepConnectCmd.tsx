import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { StaticStatus, TlsStatus } from "../../../lib/types";
import { invoke } from "../../../lib/tauri";
import {
  McpScope,
  buildDisplayHost,
  buildBaseCommand,
  buildConnectCommand,
  buildPermissionGrantCommand,
  copyText,
} from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { useToast } from "../../ui/toast";

function CommandBox({ command, copied, onCopy }: { command: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
      <span className="mt-[1px] shrink-0 font-mono text-xs font-semibold text-primary/30">$</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
        {command || "加载中..."}
      </code>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onCopy} disabled={!command}>
        <Icon name={copied ? "check" : "copy"} size={14} />
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

/**
 * 引导第 3 步：生成并复制连接命令（claude mcp add ...）。
 * 作用域选择 + 一键复制；附带「权限自动授权」可选区块，免去每次工具调用弹窗确认。
 */
export function StepConnectCmd({
  status,
  selectedIp,
  onCopied,
}: {
  status?: StaticStatus;
  selectedIp: string;
  /** H3：本步完成态——用户复制过连接命令后上报，供向导显示“已完成”。 */
  onCopied?: () => void;
}) {
  const [scope, setScope] = useState<McpScope>("project");
  const [copied, setCopied] = useState(false);
  const [permCopied, setPermCopied] = useState(false);
  const { toast } = useToast();
  // P1 遗留修复：TLS 开启时接入命令须切 https（与设置页共享 ["tls-status"] 缓存）。
  const { data: tls } = useQuery({
    queryKey: ["tls-status"],
    queryFn: () => invoke<TlsStatus>("get_tls_status"),
  });
  const tlsEnabled = !!tls?.enabled;

  const displayHost = buildDisplayHost(status, selectedIp);
  const port = status?.port ?? 7823;
  const token = status?.token ?? "";
  const baseCommand = buildBaseCommand(displayHost, port, token, status?.transport, tlsEnabled);
  const connectCommand = buildConnectCommand(baseCommand, scope);
  const permissionCommand = buildPermissionGrantCommand(scope, "", false);

  // H6 修复：之前未 await/catch，剪贴板权限被拒绝时会出现"显示已复制但其实没复制"的假阳性反馈。
  const copyConnect = () => {
    if (!connectCommand) return;
    void copyText(
      connectCommand,
      () => {
        setCopied(true);
        onCopied?.();
        setTimeout(() => setCopied(false), 2000);
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  const copyPerm = () => {
    if (!permissionCommand) return;
    void copyText(
      permissionCommand,
      () => {
        setPermCopied(true);
        setTimeout(() => setPermCopied(false), 2000);
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        下面这条命令会把 cc-bridge 注册进远程的 Claude Code。选好作用域后复制，到远程 Linux 上粘贴执行即可。
      </p>

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setScope("project")}
          className={`relative rounded-lg border-2 p-3 text-left transition-colors ${
            scope === "project"
              ? "border-primary bg-accent shadow-ring-focus"
              : "border-transparent bg-muted/50 hover:bg-muted"
          }`}
        >
          <span className="text-sm font-medium">项目级</span>
          <span className="ml-2 rounded-full bg-secondary px-1.5 py-0.5 text-[10px]">推荐</span>
          <p className="mt-1 text-xs text-muted-foreground">仅当前项目生效</p>
        </button>
        <button
          onClick={() => setScope("user")}
          className={`relative rounded-lg border-2 p-3 text-left transition-colors ${
            scope === "user"
              ? "border-primary bg-accent shadow-ring-focus"
              : "border-transparent bg-muted/50 hover:bg-muted"
          }`}
        >
          <span className="text-sm font-medium">全局模式</span>
          <p className="mt-1 text-xs text-muted-foreground">所有项目都能用</p>
        </button>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground/80">连接命令（复制后到远程执行）</p>
        <CommandBox command={connectCommand} copied={copied} onCopy={copyConnect} />
        {tlsEnabled && (
          <p className="rounded-lg bg-warning/8 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
            <b className="text-warning-ink">HTTPS 自签</b>
            ：远程 Claude Code 需先信任桥的自签证书——在「设置 › 安全 › HTTPS 远程访问」复制证书 PEM
            保存为 cc-bridge.crt，并在启动 claude 前设置 NODE_EXTRA_CA_CERTS=证书路径。
          </p>
        )}
      </div>

      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <p className="text-xs font-medium text-foreground/80">可选 · 权限自动授权</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Claude Code 每次调用工具都会弹窗确认。复制下面命令到远程执行一次，即可免去后续所有工具调用的重复授权（不改连接命令本身）。
        </p>
        <CommandBox command={permissionCommand} copied={permCopied} onCopy={copyPerm} />
        <p className="text-[11px] text-muted-foreground">
          想进一步免确认「命令执行」能力（等价于授予远程任意命令执行权限），可到「连接」页的权限授权区块开启。
        </p>
      </div>
    </div>
  );
}
