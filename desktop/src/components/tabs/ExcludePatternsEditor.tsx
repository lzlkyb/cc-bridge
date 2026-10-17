import { useState, type KeyboardEvent, type ClipboardEvent } from "react";
import { invoke } from "../../lib/tauri";
import type { ConfigSaveResult } from "../../lib/types";
import { globMatch } from "../../lib/utils";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";

/** 预置模板：一键加入最高频的排除项（与设计稿一致）。 */
const PRESETS = [".git/**", "node_modules/**", ".env*", "*.key"] as const;

/** 预览样例路径（相对白名单根），覆盖跨层 / 段名 / 普通文件三种形态。 */
const SAMPLES = [
  ".env.local",
  "config/.env.production",
  "secrets/api.key",
  "node_modules/react/index.js",
  "src/main.tsx",
] as const;

/**
 * 白名单「排除规则」编辑器（.mcpignore 式，白名单卡内一节）。
 *
 * 每次增删**立即落库**（save_config patch excludePatterns），与上方根目录列表
 * 同一交互范式——不做「编辑中草稿」态，避免改到一半忘了保存。后端会 normalize
 * （去空白/丢空串/去重）并反向同步进当前配置组存档；切换组时随组整体换入。
 *
 * 匹配语义由后端 path.rs 强制；本组件的实时预览用的是 utils.globMatch
 * （与 Rust 侧同语义的 TS 镜像），只供人工参考。
 */
export function ExcludePatternsEditor({
  patterns,
  onSaved,
}: {
  patterns: string[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState("");

  const save = async (next: string[]) => {
    try {
      await invoke<ConfigSaveResult>("save_config", { patch: { excludePatterns: next } });
      onSaved();
    } catch (e) {
      toast(`保存排除规则失败：${e}`, "error");
    }
  };

  const add = (raw: string) => {
    const t = raw.trim();
    if (!t || patterns.includes(t)) return;
    void save([...patterns, t]);
  };

  const remove = (p: string) => void save(patterns.filter((v) => v !== p));

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      draft.split(/[,;\s]+/).filter(Boolean).forEach(add);
      setDraft("");
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.clipboardData.getData("text").split(/[,;\s]+/).filter(Boolean).forEach(add);
    setDraft("");
  };

  return (
    <div className="space-y-2">
      {/* 芯片区 */}
      <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5">
        {patterns.length === 0 && (
          <span className="text-xs text-muted-foreground">无排除规则（白名单内全部可访问）</span>
        )}
        {patterns.map((p) => (
          <span
            key={p}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-[3px] font-mono text-[11.5px] font-semibold text-foreground"
          >
            {p}
            <button
              type="button"
              aria-label={`删除规则 ${p}`}
              className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-xs leading-none opacity-50 transition-opacity hover:opacity-100"
              onClick={() => remove(p)}
            >
              &times;
            </button>
          </span>
        ))}
      </div>

      {/* 输入 + 预置模板 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="h-[32px] min-w-[180px] flex-1 rounded-md border border-input bg-card px-2.5 font-mono text-xs text-foreground transition-colors focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="输入排除模式，如 src/generated/**"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onPaste={handlePaste}
        />
        <Button variant="outline" size="sm" onClick={() => { draft.split(/[,;\s]+/).filter(Boolean).forEach(add); setDraft(""); }}>
          <Icon name="plus" size={14} />
          添加
        </Button>
        <div className="flex items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              title={`添加排除规则 ${p}`}
              className="rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary hover:bg-muted hover:text-foreground"
              onClick={() => add(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* 命中预览：随当前规则实时演算（语义与后端 path.rs 一致，仅人工参考） */}
      <div className="rounded-md bg-muted/50 px-3 py-2">
        <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground">
          匹配预览 · 命中即拒绝
        </div>
        <div className="space-y-1">
          {SAMPLES.map((s) => {
            const hit = patterns.some((p) => globMatch(p, s));
            return (
              <div key={s} className="flex items-center gap-1.5 font-mono text-[11.5px]">
                {hit ? (
                  <Icon name="close" size={12} className="shrink-0 text-destructive" />
                ) : (
                  <Icon name="check" size={12} className="shrink-0 text-success" />
                )}
                <span className={hit ? "text-muted-foreground line-through" : "text-foreground"}>
                  {s}
                </span>
                <span className={`ml-auto text-[10.5px] ${hit ? "text-destructive-ink" : "text-muted-foreground"}`}>
                  {hit ? "拒绝" : "放行"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-[10.5px] text-muted-foreground">
        对所有白名单根目录生效；被拒请求照常留痕到「日志」页。仅在白名单校验开启时生效。
      </p>
    </div>
  );
}
