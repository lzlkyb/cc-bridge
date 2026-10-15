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
import {
  buildClientSnippet,
  CLIENT_LABELS,
  CLIENT_SELFSIGNED,
  CLIENT_VERIFY,
  type McpClientTool,
} from "../../../lib/mcpClients";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { useToast } from "../../ui/toast";
import { CopySegs } from "../../tabs/connect/widgets";

const TOOLS: McpClientTool[] = ["claude-code", "workbuddy", "codex", "generic"];

/**
 * 引导里的工具短标签。刻意不复用 CLIENT_LABELS：那是接入向导（连接页宽卡片）的
 * 口径，「通用 MCP 工具」这五个字塞进本弹窗 448px 宽的四分段选择器里会挤爆；
 * 这里只求能点得准，完整名称由下方正文的 CLIENT_LABELS 给出。
 */
const SHORT_LABELS: Record<McpClientTool, string> = {
  "claude-code": "Claude Code",
  workbuddy: "WorkBuddy",
  codex: "Codex",
  generic: "通用",
};

function CodeBox({
  code,
  copied,
  onCopy,
  prompt = false,
}: {
  code: string;
  copied: boolean;
  onCopy: () => void;
  /** true = 命令（带 `$` 前缀）；false = 配置片段（JSON / TOML，裸文本）。 */
  prompt?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
      {prompt && (
        <span className="mt-[1px] shrink-0 font-mono text-xs font-semibold text-primary/30">$</span>
      )}
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
        {code || "加载中..."}
      </code>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onCopy} disabled={!code}>
        <Icon name={copied ? "check" : "copy"} size={14} />
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

/**
 * 引导第 3 步：选接入工具 → 生成并复制对应的配置片段。
 *
 * 身份从「Claude Code 专属桥」扩到「任意 MCP 工具」后，本步不能只产 `claude mcp add`：
 * - **Claude Code**（默认）：沿用原有内容——作用域选择 + CLI 命令 + 权限自动授权；
 * - **WorkBuddy / Codex / 通用**：改走 `lib/mcpClients` 的 `buildClientSnippet`，
 *   与连接页接入向导**同源**产出片段（JSON / TOML），文案也用同一份 CLIENT_VERIFY /
 *   CLIENT_SELFSIGNED，避免两处各说各话。
 *
 * 默认仍停在 Claude Code——它是新装用户的主路径，多这一步切换不该抬高默认路径的成本。
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
  const [tool, setTool] = useState<McpClientTool>("claude-code");
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
  // 后端下发的 transport 是自由文本，片段生成器只认这两态，收口在这里。
  const transport: "http" | "sse" = status?.transport === "sse" ? "sse" : "http";
  const baseCommand = buildBaseCommand(displayHost, port, token, status?.transport, tlsEnabled);
  const connectCommand = buildConnectCommand(baseCommand, scope);
  const permissionCommand = buildPermissionGrantCommand(scope, "", false);
  const snippet = buildClientSnippet(tool, { host: displayHost, port, token, transport, tls: tlsEnabled });

  /** 本步要复制的那一份：Claude Code 是 CLI 命令，其余是配置文件片段。 */
  const payload = tool === "claude-code" ? connectCommand : snippet.code;

  // H6 修复：之前未 await/catch，剪贴板权限被拒绝时会出现"显示已复制但其实没复制"的假阳性反馈。
  const copyPayload = () => {
    if (!payload) return;
    void copyText(
      payload,
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
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground/80">接入工具</span>
        <div
          role="group"
          aria-label="选择接入工具"
          className="flex shrink-0 rounded-lg border bg-muted p-0.5"
        >
          {TOOLS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTool(t);
                setCopied(false);
              }}
              aria-pressed={tool === t}
              className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                tool === t
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {SHORT_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {tool === "claude-code" ? (
        <>
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
              <span className="ml-2 rounded-full bg-secondary px-1.5 py-0.5 text-[11px]">推荐</span>
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
            <CodeBox code={connectCommand} copied={copied} onCopy={copyPayload} prompt />
          </div>

          <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground/80">可选 · 权限自动授权</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Claude Code 每次调用工具都会弹窗确认。复制下面命令到远程执行一次，即可免去后续所有工具调用的重复授权（不改连接命令本身）。
            </p>
            <CodeBox code={permissionCommand} copied={permCopied} onCopy={copyPerm} prompt />
            <p className="text-xs text-muted-foreground">
              想进一步免确认「命令执行」能力（等价于授予远程任意命令执行权限），可到「连接」页的权限授权区块开启。
            </p>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">
            把下面这段配置写进 {CLIENT_LABELS[tool]} 的配置文件（
            <b className="text-foreground">{snippet.target}</b>），保存后重启该工具即可接入。
          </p>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground/80">
              {snippet.kind === "toml" ? "TOML 配置" : "JSON 配置"}
            </p>
            <CodeBox code={snippet.code} copied={copied} onCopy={copyPayload} />
          </div>

          {snippet.notes.map((n, i) => (
            <p
              key={i}
              className="rounded-lg bg-warning/8 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
            >
              <b className="text-warning-ink">注意</b>：{n}
            </p>
          ))}

          <p className="text-xs leading-relaxed text-muted-foreground">
            验证：{CLIENT_VERIFY[tool]}
          </p>

          <p className="text-xs leading-relaxed text-muted-foreground">
            想换成其它工具？所有工具的完整接入步骤与自签证书信任方式，都在「连接」页的接入向导里。
          </p>
        </>
      )}

      {/* 自签信任提示按工具取文案（与连接页徽章行同一数据源）。只在开 HTTPS 时出现：
          HTTP 模式下没有证书可信任，提示纯属噪音。 */}
      {tlsEnabled && (
        <p className="rounded-lg bg-warning/8 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          <b className="text-warning-ink">HTTPS 自签</b>：
          <CopySegs segs={CLIENT_SELFSIGNED[tool].note} />
        </p>
      )}
    </div>
  );
}
