import { useState } from "react";
import { invoke } from "../../lib/tauri";
import type { StaticStatus, ConfigSaveResult } from "../../lib/types";
import { malformedCcRules, parseCcRules } from "../../lib/ccAutoApprove";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { SavedHint } from "../ui/SavedHint";
import { useToast } from "../ui/toast";

/** 占位示例：同时覆盖「带参数」「只写工具名」「命令写全」三种形态。 */
const PLACEHOLDER = "Read(src/**)\nEdit(src/**)\nBash(git status)";

/**
 * 「CC 审批自动放行」卡（安全页，与命令白名单同族）。
 *
 * 语义全部在 Rust `cc_session::autoapprove`：命中即 allow、照常写审计、
 * `AskUserQuestion` 永不自动放行、空表 = 全人工。这里只做编辑与保存，
 * 不复制匹配逻辑——两份实现必然 diverging，而 diverge 的方向永远是
 * 「界面说放了、后端没放」。
 */
export function CcAutoApproveCard({
  status,
  onSaved,
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const rules = status?.ccAutoApproveRules ?? [];
  // null = 未编辑，显示已保存值。多行文本不做「每次按键存一次」——
  // 打一半的规则被存进去，下一轮审批就可能按半成品放行。
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { toast } = useToast();

  const text = draft ?? rules.join("\n");
  const parsed = parseCcRules(text);
  const dirty = draft !== null && parsed.join("\n") !== parseCcRules(rules.join("\n")).join("\n");
  const bad = malformedCcRules(parsed);

  const save = async () => {
    try {
      await invoke<ConfigSaveResult>("save_config", { patch: { ccAutoApproveRules: parsed } });
      setDraft(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved();
    } catch (e) {
      toast(`保存失败：${e}`, "error");
    }
  };

  return (
    <Card id="sec-cc-approve">
      <CardHeader className="flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <CardTitle icon={<Icon name="shield" />}>CC 审批自动放行</CardTitle>
          {status && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                rules.length === 0
                  ? "bg-muted text-muted-foreground"
                  : "bg-success/10 text-success-ink"
              }`}
            >
              {rules.length === 0 ? "未启用 · 全部人工审批" : `${rules.length} 条规则`}
            </span>
          )}
        </div>
        {saved && <SavedHint>已保存</SavedHint>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-foreground">
          <Icon name="alertTriangle" size={15} className="mt-0.5 shrink-0 text-warning-ink" />
          <span>
            命中规则的审批会被<b>自动放行</b>，不再弹卡；每次放行都照常写审计日志，对话流里标
            「已按规则自动放行」。<code className="rounded bg-background/60 px-1 font-mono">AskUserQuestion</code>{" "}
            提问永不自动放行。
            <br />
            glob 的 <code className="rounded bg-background/60 px-1 font-mono">*</code> 会跨{" "}
            <code className="rounded bg-background/60 px-1 font-mono">/</code> 与空格：
            <code className="rounded bg-background/60 px-1 font-mono">Bash(git*)</code> 会把
            <code className="rounded bg-background/60 px-1 font-mono">git status &amp;&amp; rm -rf /</code>{" "}
            整串放行——命令要写全、写窄。空列表 = 全部人工审批（默认）。
          </span>
        </div>

        <textarea
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          rows={6}
          spellCheck={false}
          disabled={!status}
          placeholder={PLACEHOLDER}
          aria-label="CC 审批自动放行规则，一行一条"
          className="w-full resize-y rounded-md border border-input bg-card px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground transition-colors placeholder:text-muted-foreground/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />

        {bad.length > 0 && (
          <div className="space-y-1">
            {bad.map((b) => (
              <div key={b.line} className="flex items-center gap-1.5 text-[11px] text-warning-ink">
                <Icon name="alertTriangle" size={12} className="shrink-0" />
                <span className="shrink-0">第 {b.line} 行格式存疑：</span>
                <code className="truncate font-mono">{b.rule}</code>
                <span className="shrink-0 text-muted-foreground">（保存后会被后端忽略）</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!status || !dirty} onClick={() => void save()}>
            保存
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty}
            onClick={() => setDraft(null)}
          >
            撤销修改
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">
            一行一条 <code className="font-mono">工具名(主参数glob)</code>；只写工具名 = 该工具全部放行
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
