import { useState } from "react";
import type { CopySeg, CopyStep } from "../../../lib/mcpClients";
import { invoke } from "../../../lib/tauri";
import { copyText } from "../../../lib/utils";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { useToast } from "../../ui/toast";

/** 步骤序号圆点：done 时显示对勾 */
export function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      className={`step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${done ? "step-num--done" : ""}`}
    >
      {done ? "✓" : n}
    </span>
  );
}

/** 接入作用域选择卡（项目级 / 全局模式），选中态强化 */
export function OptionCard({
  selected,
  title,
  desc,
  badge,
  onClick,
}: {
  selected: boolean;
  title: string;
  desc: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative rounded-lg border-2 p-3 text-left transition-colors ${
        selected
          ? "border-primary bg-accent shadow-ring-focus"
          : "border-transparent bg-muted/50 hover:bg-muted"
      }`}
    >
      {selected && (
        <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
          <Icon name="check" size={12} />
        </span>
      )}
      <div className="mb-1 flex items-center gap-2">
        <span className={`text-sm font-medium ${selected ? "text-primary" : ""}`}>{title}</span>
        {badge && <Badge variant="secondary">{badge}</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">{desc}</p>
    </button>
  );
}

/** 终端风格命令块：命令 + 复制按钮。按钮文案变化经 aria-live 播报（复制反馈规范 ⑤）。 */
export function CommandBlock({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="code-box flex items-start gap-2">
      <span className="mt-[1px] shrink-0 font-mono text-xs font-semibold text-primary/30">$</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
        {command || "加载中..."}
      </code>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onCopy} disabled={!command} aria-live="polite">
        <Icon name={copied ? "check" : "copy"} size={14} />
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

/** 渲染自签文案片段：字符串直出，`{ env }` 渲染为等宽 chip（徽章行与信任步骤共用）。 */
export function CopySegs({ segs }: { segs: CopySeg[] }) {
  return (
    <>
      {segs.map((s, i) =>
        typeof s === "string" ? (
          <span key={i}>{s}</span>
        ) : (
          <code
            key={i}
            className="rounded border bg-muted px-1 font-mono text-[10.5px] text-foreground"
          >
            {s.env}
          </code>
        ),
      )}
    </>
  );
}

/**
 * 「复制 PEM」步骤：HTTPS 自签时把证书内容交给用户保存为 .crt 信任用（ToolGuide / GenericSteps 共用）。
 * 传 `steps` 时在下方追加「信任步骤」有序列表——每态都给出**做法**，而不是悬挂的「待实测」。
 */
export function CertPemStep({
  compact,
  copied,
  onCopied,
  steps,
}: {
  compact?: boolean;
  copied?: boolean;
  onCopied?: () => void;
  /** 信任步骤（`CLIENT_SELFSIGNED[tool].steps`）；不传则只出「复制 PEM」一行。 */
  steps?: CopyStep[];
}) {
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
    <div className={compact ? "" : "rounded-lg border bg-muted/30 px-2.5 py-2"}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
          {compact
            ? "把下方证书内容保存为 cc-bridge.crt 供工具信任："
            : "导出桥的自签证书（PEM），保存后按各工具要求信任"}
        </p>
        <Button variant="outline" size="sm" className="shrink-0" onClick={copyPem} disabled={loading}>
          <Icon name={done ? "check" : "copy"} size={12} />
          {loading ? "读取中…" : done ? "已复制" : "复制 PEM"}
        </Button>
      </div>
      {steps && steps.length > 0 && (
        <div className="mt-2 border-t border-dashed pt-2">
          <b className="text-[11px] font-semibold text-foreground">信任步骤</b>
          <ol className="ml-4 mt-1 list-decimal space-y-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {steps.map((step, i) => (
              <li key={i}>
                <CopySegs segs={step} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
