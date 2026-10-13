import { useState } from "react";
import type { ReactNode } from "react";
import {
  buildClientSnippet,
  CLIENT_LABELS,
  CLIENT_SELFSIGNED,
  CLIENT_VERIFY,
  type McpClientTool,
  type SnippetInput,
} from "../../../lib/mcpClients";
import { useCopyFeedback } from "../../../hooks/useCopyFeedback";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { CertPemStep, StepNumber } from "./widgets";
import { GenericSteps } from "./GenericSteps";

const TOOLS: McpClientTool[] = ["claude-code", "workbuddy", "codex", "generic"];

/**
 * P2-3 接入向导多工具化：卡头四工具分段选择器 + 非 Claude 工具的配置片段渲染。
 *
 * - 工具选择态是 UI 本地 state（不落盘——scope 影响托盘命令，工具不影响）；
 * - claude-code 沿用现有向导内容（scope 切换 / Global/ProjectSteps / Token / 权限），
 *   由 children 传入，仅 claude-code 时渲染；
 * - WorkBuddy / Codex 走 ManualSteps（JSON/TOML 片段）；generic 走 GenericSteps
 *   （「复制提示词发给 AI 代接入」为主、手动 JSON 折叠备用）；
 * - TLS 开启时片段自动 https，并追加「复制 PEM」步骤（read_tls_cert_pem）。
 */
export function ToolGuide({
  host,
  port,
  token,
  transport,
  tlsEnabled = false,
  children,
}: {
  host: string;
  port: number;
  token: string;
  transport: "http" | "sse";
  /** HTTPS 远程访问开关（父层读 get_tls_status.enabled 后传入布尔，本组件不重复查询）。 */
  tlsEnabled?: boolean;
  /** claude-code 现有向导内容（scope / steps / token / perm），仅该工具渲染。 */
  children: ReactNode;
}) {
  const [tool, setTool] = useState<McpClientTool>("claude-code");
  const input: SnippetInput = { host, port, token, transport, tls: tlsEnabled };

  return (
    <Card className="card-primary">
      <CardHeader>
        {/* 分段选择器嵌标题行右侧（与设计稿一致：guide-title + ml-auto，不再独占一整行） */}
        <div className="flex items-center justify-between gap-3">
          <CardTitle icon={<Icon name="plug" />}>接入 {CLIENT_LABELS[tool]}</CardTitle>
          <div
            role="group"
            aria-label="选择接入工具"
            className="flex shrink-0 rounded-lg border bg-muted p-0.5"
          >
            {TOOLS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTool(t)}
                aria-pressed={tool === t}
                className={`whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  tool === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {CLIENT_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 自签兼容性徽章行（与 docs/client-compatibility.md 同源口径） */}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          自签兼容性：
          <span
            className={`ml-1 mr-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              CLIENT_SELFSIGNED[tool].level === "ok"
                ? "bg-success/12 text-success"
                : "bg-warning/12 text-warning"
            }`}
          >
            {CLIENT_SELFSIGNED[tool].level === "ok" ? "可信任" : "待实测"}
          </span>
          {CLIENT_SELFSIGNED[tool].note}
        </p>

        {/* Tab 内容切换微动画：key={tool} 换工具时重挂 → animate-tab-in 播入场
            （与顶层 Tab 页切换同一套语言，复用现有 keyframes，零新增 CSS）。
            wrapper 接管了 CardContent 的 space-y-4（后者现在只隔 wrapper 与上方两兄弟），
            故 wrapper 自带 space-y-4 保住 guide 块之间原本的间距。 */}
        <div key={tool} className="animate-tab-in space-y-4">
          {tool === "claude-code" ? (
            <>
              {children}
              {tlsEnabled && <ClaudeTlsNote input={input} />}
            </>
          ) : tool === "generic" ? (
            <GenericSteps input={input} />
          ) : (
            <ManualSteps tool={tool} input={input} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** claude-code 的 HTTPS 附加说明（现有 Global/ProjectSteps 不感知 TLS，补在这里）。 */
function ClaudeTlsNote({ input }: { input: SnippetInput }) {
  const notes = buildClientSnippet("claude-code", input).notes;
  if (notes.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/8 p-3">
      {notes.map((n, i) => (
        <p key={i} className="text-[11px] leading-relaxed text-muted-foreground">
          <b className="text-warning">HTTPS 自签</b>
          ：{n}
        </p>
      ))}
      <CertPemStep compact />
    </div>
  );
}

/** WorkBuddy / Codex 的手动接入步骤：配置载体 → 片段 + notes → 验证。 */
function ManualSteps({ tool, input }: { tool: McpClientTool; input: SnippetInput }) {
  const snippet = buildClientSnippet(tool, input);
  const [pemCopied, setPemCopied] = useState(false);
  // 复制反馈统一走 useCopyFeedback（评审修复 ⑤）：成功仅内联、失败 toast。
  const fb = useCopyFeedback();

  return (
    <div className="space-y-4">
      <div className="step-row flex gap-3">
        <StepNumber n={1} />
        <div className="flex-1 space-y-1.5">
          <p className="ui-h-sub">{snippet.target}</p>
          <p className="text-xs text-muted-foreground">文件不存在则新建；粘贴后保存</p>
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={2} />
        <div className="flex-1 space-y-2">
          <p className="ui-h-sub">粘贴以下{snippet.kind === "toml" ? " TOML" : " JSON"}配置</p>
          <div className="code-box flex items-start gap-2">
            <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
              {snippet.code}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => fb.copy("snippet", snippet.code)}
              aria-live="polite"
            >
              <Icon name={fb.isCopied("snippet") ? "check" : "copy"} size={14} />
              {fb.isCopied("snippet") ? "已复制" : "复制"}
            </Button>
          </div>
          {snippet.notes.map((n, i) => (
            <p key={i} className="rounded-lg bg-warning/8 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <b className="text-warning">注意</b>
              ：{n}
            </p>
          ))}
          {input.tls && <CertPemStep copied={pemCopied} onCopied={() => setPemCopied(true)} />}
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={3} done />
        <div className="flex-1 space-y-1.5">
          <p className="ui-h-sub">完成</p>
          <p className="text-xs text-muted-foreground">{CLIENT_VERIFY[tool]}</p>
        </div>
      </div>
    </div>
  );
}
