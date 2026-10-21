import { useState } from "react";
import type { ReactNode } from "react";
import {
  buildClientSnippet,
  CLIENT_LABELS,
  CLIENT_SELFSIGNED,
  CLIENT_VERIFY,
  SELFSIGNED_BADGE,
  type McpClientTool,
  type SnippetInput,
} from "../../../lib/mcpClients";
import { useCopyFeedback } from "../../../hooks/useCopyFeedback";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { CertPemStep, CopySegs, StepNumber } from "./widgets";
import { GenericSteps } from "./GenericSteps";
import { MultiDeviceToggle } from "./MultiDeviceToggle";

const TOOLS: McpClientTool[] = ["claude-code", "workbuddy", "codex", "generic"];

/**
 * P2-3 接入向导多工具化：卡头四工具分段选择器 + 非 Claude 工具的配置片段渲染。
 *
 * - 工具选择态**落盘**（`config.connect_client`）：托盘「复制命令/复制 IP」与连接页
 *   IpChangedBanner 都要按同一个工具出内容，选择必须跨重启保持——早先只当纯 UI state，
 *   于是托盘永远按 Claude Code 出命令，选了 Codex 的用户会拿到一条用不上的 CLI 命令。
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
  defaultTool = "claude-code",
  onToolChange,
  multiDevice = false,
  deviceId = "",
  deviceName = "",
  onToggleMultiDevice,
  children,
}: {
  host: string;
  port: number;
  token: string;
  transport: "http" | "sse";
  /** HTTPS 远程访问开关（父层读 get_tls_status.enabled 后传入布尔，本组件不重复查询）。 */
  tlsEnabled?: boolean;
  /** 初始选中的工具（来自 `config.connect_client`，刷新后保持上次选择）。 */
  defaultTool?: McpClientTool;
  /** 切换工具时上报——父层落盘 `connect_client`，托盘/横幅的命令形态随之改变。 */
  onToolChange?: (tool: McpClientTool) => void;
  /** 多设备模式开关（opt-in）：开启时 WorkBuddy/Codex 手动片段条目名带本机尾号。 */
  multiDevice?: boolean;
  /** 本机身份尾号（多设备模式主键；空 = 单设备，片段条目名维持 cc-bridge）。 */
  deviceId?: string;
  /** 本机身份名（多设备 chip 悬停展示与复制用）。 */
  deviceName?: string;
  /** 多设备开关回调（ConnectTab 落盘 save_config + onRefresh）。不传则不渲染开关。 */
  onToggleMultiDevice?: (next: boolean) => void;
  /** claude-code 现有向导内容（scope / steps / token / perm），仅该工具渲染。 */
  children: ReactNode;
}) {
  const [tool, setTool] = useState<McpClientTool>(defaultTool);
  const input: SnippetInput = {
    host,
    port,
    token,
    transport,
    tls: tlsEnabled,
    deviceId: multiDevice ? deviceId : undefined,
  };
  /** 当前工具的自签兼容性条目（徽章行 + 信任步骤的唯一数据源）。 */
  const sel = CLIENT_SELFSIGNED[tool];

  return (
    <Card className="card-primary">
      <CardHeader>
        {/* 卡头右侧：多设备开关（紧贴命令产出地——它决定接入命令的形态）+ 四工具分段器。
            flex-wrap：窄窗时开关组折到第二行，绝不挤压/截断分段器。 */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle icon={<Icon name="plug" />}>接入 {CLIENT_LABELS[tool]}</CardTitle>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {onToggleMultiDevice && (
              <MultiDeviceToggle
                enabled={multiDevice}
                deviceId={deviceId}
                deviceName={deviceName}
                onToggle={onToggleMultiDevice}
              />
            )}
            <div
              role="group"
              aria-label="选择接入工具"
              className="client-selector flex min-w-0 max-w-full flex-wrap rounded-lg border bg-muted p-0.5"
            >
            {TOOLS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTool(t);
                  // 上报给父层落盘（connect_client）——托盘与 IpChangedBanner 依赖它。
                  onToolChange?.(t);
                }}
                aria-pressed={tool === t}
                className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
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
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 自签兼容性徽章行（三态，与 docs/client-compatibility.md 同源口径）。
            仅在 HTTPS 远程访问开启时出现：这一行讲的是「自签证书能否被该工具信任」，
            只有桥切到 HTTPS（get_tls_status.enabled）时才成立。未开 TLS 时提示"自签
            信任"是纯噪音——用户根本没有证书可信任，也无从判断该不该关心。
            与下方 CertPemStep / snippet.notes 同一收口口径（都挂 tlsEnabled/tls）。 */}
        {tlsEnabled && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            自签兼容性：
            <span
              className={`mx-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${SELFSIGNED_BADGE[sel.level].className}`}
            >
              <Icon name={SELFSIGNED_BADGE[sel.level].icon} size={10} aria-hidden="true" />
              {SELFSIGNED_BADGE[sel.level].label}
            </span>
            {/* 未实测的态不装「已验证」——文档依据与真机结论分开标。 */}
            {!sel.verified && (
              <span className="mr-1 inline-flex items-center rounded border bg-background px-1 py-px text-[10px] font-semibold text-muted-foreground">
                文档依据 · 待实测
              </span>
            )}
            <CopySegs segs={sel.note} />
          </p>
        )}

        {/* Tab 内容切换微动画：key={tool} 换工具时重挂 → animate-tab-in 播入场
            （与顶层 Tab 页切换同一套语言，复用现有 keyframes，零新增 CSS）。
            wrapper 接管了 CardContent 的 space-y-4（后者现在只隔 wrapper 与上方两兄弟），
            故 wrapper 自带 space-y-4 保住 guide 块之间原本的间距。 */}
        <div key={tool} className="animate-tab-in space-y-4">
          {tool === "claude-code" ? (
            <>
              {children}
              {tlsEnabled && <ClaudeTlsNote />}
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

/**
 * claude-code 的 HTTPS 附加说明（Global/ProjectSteps 不感知 TLS，补在这里）。
 * 文案与信任步骤统一取自 CLIENT_SELFSIGNED["claude-code"]——不再走 buildClientSnippet 的 notes，
 * 免得同一件事在片段 note 与信任步骤里各说一遍。
 */
function ClaudeTlsNote() {
  const sel = CLIENT_SELFSIGNED["claude-code"];
  return (
    <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/8 p-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        <b className="text-warning-ink">HTTPS 自签</b>
        ：
        <CopySegs segs={sel.note} />
      </p>
      <CertPemStep compact steps={sel.steps} />
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
            <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
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
            <p key={i} className="rounded-lg bg-warning/8 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
              <b className="text-warning-ink">注意</b>
              ：{n}
            </p>
          ))}
          {input.tls && (
            <CertPemStep
              copied={pemCopied}
              onCopied={() => setPemCopied(true)}
              steps={CLIENT_SELFSIGNED[tool].steps}
            />
          )}
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
