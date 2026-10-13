import { useState } from "react";
import {
  buildClientSnippet,
  buildGenericPrompt,
  CLIENT_VERIFY,
  type SnippetInput,
} from "../../../lib/mcpClients";
import { useCopyFeedback } from "../../../hooks/useCopyFeedback";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { CertPemStep, StepNumber } from "./widgets";

/**
 * 通用工具的接入步骤（方案 A，2026-10-13）：主路径是「复制提示词发给 AI 代接入」——
 * 任意支持 MCP 的工具里，AI 自己识别配置载体（命令 / json / toml）、写入并验证。
 * 备用路径是无对话界面的纯 CLI 工具：手动配置 JSON 默认折叠，兜底成本极低。
 */
export function GenericSteps({ input }: { input: SnippetInput }) {
  const prompt = buildGenericPrompt(input);
  const snippet = buildClientSnippet("generic", input);
  const [showManual, setShowManual] = useState(false);
  const [pemCopied, setPemCopied] = useState(false);
  // 复制反馈统一走 useCopyFeedback（评审修复 ⑤）：成功仅内联、失败 toast。
  const fb = useCopyFeedback();

  return (
    <div className="space-y-4">
      <div className="step-row flex gap-3">
        <StepNumber n={1} />
        <div className="flex-1 space-y-2">
          <p className="ui-h-sub">复制提示词，发给该工具里的 AI</p>
          <p className="text-xs text-muted-foreground">
            适用于任意支持 MCP 的工具：整段粘贴后，AI 会自己识别配置载体（命令 / json / toml）、写入并验证。
          </p>
          <div className="code-box flex items-start gap-2">
            <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
              {prompt}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => fb.copy("prompt", prompt)}
              aria-live="polite"
            >
              <Icon name={fb.isCopied("prompt") ? "check" : "copy"} size={14} />
              {fb.isCopied("prompt") ? "已复制" : "复制"}
            </Button>
          </div>
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={2} done />
        <div className="flex-1 space-y-1.5">
          <p className="ui-h-sub">完成</p>
          <p className="text-xs text-muted-foreground">{CLIENT_VERIFY.generic}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-muted/30">
        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          aria-expanded={showManual}
          className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        >
          <Icon
            name="chevronDown"
            size={13}
            className={`shrink-0 text-muted-foreground transition-transform ${showManual ? "" : "-rotate-90"}`}
          />
          <span className="text-xs font-medium">备用：手动配置（无 AI 代填时）</span>
        </button>
        {showManual && (
          <div className="space-y-2 border-t px-2.5 py-2.5">
            <p className="text-[11px] text-muted-foreground">{snippet.target}</p>
            <div className="code-box flex items-start gap-2">
              <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
                {snippet.code}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => fb.copy("manual", snippet.code)}
                aria-live="polite"
              >
                <Icon name={fb.isCopied("manual") ? "check" : "copy"} size={14} />
                {fb.isCopied("manual") ? "已复制" : "复制"}
              </Button>
            </div>
            {snippet.notes.map((n, i) => (
              <p
                key={i}
                className="rounded-lg bg-warning/8 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground"
              >
                <b className="text-warning">注意</b>
                ：{n}
              </p>
            ))}
            {input.tls && <CertPemStep copied={pemCopied} onCopied={() => setPemCopied(true)} />}
          </div>
        )}
      </div>
    </div>
  );
}
