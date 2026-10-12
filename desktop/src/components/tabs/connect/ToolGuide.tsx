import { useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "../../../lib/tauri";
import type { TlsStatus } from "../../../lib/types";
import {
  buildClientSnippet,
  CLIENT_LABELS,
  CLIENT_SELFSIGNED,
  CLIENT_VERIFY,
  type McpClientTool,
  type SnippetInput,
} from "../../../lib/mcpClients";
import { copyText } from "../../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";

const TOOLS: McpClientTool[] = ["claude-code", "workbuddy", "codex", "generic"];

/**
 * P2-3 接入向导多工具化：卡头四工具分段选择器 + 非 Claude 工具的配置片段渲染。
 *
 * - 工具选择态是 UI 本地 state（不落盘——scope 影响托盘命令，工具不影响）；
 * - claude-code 沿用现有向导内容（scope 切换 / Global/ProjectSteps / Token / 权限），
 *   由 children 传入，仅 claude-code 时渲染；
 * - 其余工具渲染 buildClientSnippet 生成的 JSON/TOML 片段 + 兼容性徽章 + notes；
 * - TLS 开启时（与设置页共享 get_tls_status 状态，由父组件传入）片段自动 https，
 *   并追加「复制 PEM」步骤（read_tls_cert_pem）。
 */
export function ToolGuide({
  host,
  port,
  token,
  transport,
  tls,
  children,
}: {
  host: string;
  port: number;
  token: string;
  transport: "http" | "sse";
  tls?: TlsStatus;
  /** claude-code 现有向导内容（scope / steps / token / perm），仅该工具渲染。 */
  children: ReactNode;
}) {
  const [tool, setTool] = useState<McpClientTool>("claude-code");
  const tlsEnabled = !!tls?.enabled;
  const input: SnippetInput = { host, port, token, transport, tls: tlsEnabled };

  return (
    <Card className="card-primary">
      <CardHeader>
        <CardTitle icon={<Icon name="plug" />}>接入 AI 工具</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 四工具分段选择器（工具多到放不下时再改下拉，当前 4 个一行合适） */}
        <div className="flex rounded-lg border bg-muted p-0.5">
          {TOOLS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTool(t)}
              aria-pressed={tool === t}
              className={`min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                tool === t
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {CLIENT_LABELS[t]}
            </button>
          ))}
        </div>

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

        {tool === "claude-code" ? (
          <>
            {children}
            {tlsEnabled && <ClaudeTlsNote input={input} />}
          </>
        ) : (
          <ClientSteps tool={tool} input={input} />
        )}
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

/** 非 Claude 工具的接入步骤：配置载体 → 片段 + notes → 验证。 */
function ClientSteps({ tool, input }: { tool: McpClientTool; input: SnippetInput }) {
  const snippet = buildClientSnippet(tool, input);
  const [copied, setCopied] = useState(false);
  const [pemCopied, setPemCopied] = useState(false);
  const { toast } = useToast();

  const copySnippet = () => {
    if (!snippet.code) return;
    void copyText(
      snippet.code,
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

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
            <Button variant="outline" size="sm" className="shrink-0" onClick={copySnippet}>
              <Icon name={copied ? "check" : "copy"} size={14} />
              {copied ? "已复制" : "复制"}
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

/** 「复制 PEM」步骤：HTTPS 自签时把证书内容交给用户保存为 .crt 信任用。 */
function CertPemStep({ compact, copied, onCopied }: { compact?: boolean; copied?: boolean; onCopied?: () => void }) {
  const [innerCopied, setInnerCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const done = copied ?? innerCopied;

  const copyPem = () => {
    setLoading(true);
    invoke<string>("read_tls_cert_pem")
      .then((pem) =>
        copyText(
          pem,
          () => {
            setInnerCopied(true);
            onCopied?.();
            toast("证书 PEM 已复制，保存为 cc-bridge.crt 后按工具要求信任", "success");
          },
          (e) => toast(`复制失败：${e}`, "error"),
        ),
      )
      .catch((e) => toast(`读取证书失败：${e}`, "error"))
      .finally(() => setLoading(false));
  };

  return (
    <div className={`flex items-center justify-between gap-2 ${compact ? "" : "rounded-lg border bg-muted/30 px-2.5 py-2"}`}>
      <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
        {compact ? "把下方证书内容保存为 cc-bridge.crt 供工具信任：" : "导出桥的自签证书（PEM），保存后按各工具要求信任"}
      </p>
      <Button variant="outline" size="sm" className="shrink-0" onClick={copyPem} disabled={loading}>
        <Icon name={done ? "check" : "copy"} size={12} />
        {loading ? "读取中…" : done ? "已复制" : "复制 PEM"}
      </Button>
    </div>
  );
}

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      className={`step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${done ? "step-num--done" : "bg-gradient-to-br from-primary to-primary/70"}`}
    >
      {done ? "✓" : n}
    </span>
  );
}
