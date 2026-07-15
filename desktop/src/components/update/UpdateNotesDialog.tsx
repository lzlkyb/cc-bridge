import { Icon } from "../ui/icon";

/**
 * Release Notes 前缀 → 中文标签 + 配色（跟随主题 CSS 变量，深浅色自适应）。
 * 与项目 commit 前缀规范保持一致：feat / fix / chg(change) / refactor / docs。
 */
const PREFIX_MAP: Record<string, { key: keyof typeof CHIP_STYLES; label: string }> = {
  feat: { key: "feat", label: "新功能" },
  fix: { key: "fix", label: "修复" },
  chg: { key: "chg", label: "变更" },
  change: { key: "chg", label: "变更" },
  refactor: { key: "refactor", label: "重构" },
  docs: { key: "docs", label: "文档" },
};

const CHIP_STYLES = {
  feat: { color: "var(--primary)", bg: "color-mix(in srgb, var(--primary) 12%, transparent)" },
  fix: { color: "var(--destructive)", bg: "color-mix(in srgb, var(--destructive) 12%, transparent)" },
  chg: { color: "var(--warning)", bg: "color-mix(in srgb, var(--warning) 12%, transparent)" },
  refactor: { color: "var(--muted-foreground)", bg: "color-mix(in srgb, var(--muted-foreground) 14%, transparent)" },
  docs: { color: "var(--success)", bg: "color-mix(in srgb, var(--success) 12%, transparent)" },
} as const;

/** 去重后的图例顺序（feat→fix→chg→refactor→docs），供弹窗顶部与文档展示。 */
const LEGEND: { key: keyof typeof CHIP_STYLES; label: string }[] = [
  { key: "feat", label: "新功能" },
  { key: "fix", label: "修复" },
  { key: "chg", label: "变更" },
  { key: "refactor", label: "重构" },
  { key: "docs", label: "文档" },
];

/** 轻量 Release Notes 渲染：前缀→中文标签徽章 + 列表项。纯展示，无副作用。 */
export function ReleaseNotes({ body }: { body: string | null | undefined }) {
  if (!body || !body.trim()) {
    return <div className="px-1 py-2 text-xs text-muted-foreground">本次更新暂无说明</div>;
  }
  const lines = body.split("\n");
  return (
    <div className="flex flex-col">
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (line.trim() === "") return <div key={i} className="h-1.5" />;

        const isList = /^[-*]\s+/.test(line);
        const content = isList ? line.replace(/^[-*]\s+/, "") : line;
        const m = content.match(/^(\w+):\s*(.*)$/);
        const info = m ? PREFIX_MAP[m[1].toLowerCase()] : undefined;

        if (info) {
          const st = CHIP_STYLES[info.key];
          return (
            <div key={i} className="flex items-baseline gap-2 py-[3px]">
              <span className="shrink-0 select-none text-[11px] text-muted-foreground">{isList ? "•" : "›"}</span>
              <span
                className="inline-block shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold leading-tight"
                style={{ color: st.color, background: st.bg }}
              >
                {info.label}
              </span>
              <span className="text-[12.5px] leading-snug text-foreground/90">{m![2]}</span>
            </div>
          );
        }
        return (
          <div key={i} className="flex items-baseline gap-2 py-[3px]">
            <span className="shrink-0 select-none text-[11px] text-muted-foreground">{isList ? "•" : "›"}</span>
            <span className="text-[12.5px] leading-snug text-foreground/90">{content}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 「查看更新内容」弹窗：复用应用通用 modal 视觉（modal-overlay / modal-box）。 */
export function UpdateNotesDialog({
  open,
  update,
  onClose,
  onDownload,
}: {
  open: boolean;
  update: { version?: string; body?: string | null } | null;
  onClose: () => void;
  onDownload: () => void;
}) {
  if (!open || !update) return null;
  const ver = update.version ?? "";

  return (
    <div
      className="modal-overlay fixed inset-0 z-[1000] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="modal-box mx-4 max-h-[80vh] w-[480px] max-w-[90vw] overflow-y-auto rounded-2xl border border-border p-6 shadow-2xl"
        style={{ background: "var(--color-card)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="mb-3.5 flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg text-white"
            style={{ background: "var(--version-gradient)" }}
          >
            <img src="/icon.png" alt="" className="h-5 w-5 object-contain" />
          </div>
          <div className="text-[15px] font-extrabold text-foreground">CC Bridge 更新到 v{ver}</div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* 标签图例 */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {LEGEND.map((l) => {
            const st = CHIP_STYLES[l.key];
            return (
              <span
                key={l.key}
                className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                style={{ color: st.color, background: st.bg }}
              >
                {l.label}
              </span>
            );
          })}
        </div>

        {/* 更新内容滚动区 */}
        <div className="mb-4 max-h-[320px] overflow-y-auto rounded-xl border border-border bg-muted p-3.5">
          <ReleaseNotes body={update.body ?? null} />
        </div>

        {/* 底部操作 */}
        <div className="flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-bold text-foreground transition-colors hover:bg-muted"
          >
            稍后
          </button>
          <button
            type="button"
            onClick={() => {
              onDownload();
              onClose();
            }}
            className="rounded-lg border-0 px-4.5 py-2 text-[13px] font-bold text-white shadow-sm transition-[transform,box-shadow] hover:-translate-y-px"
            style={{ background: "var(--badge-update-bg)", boxShadow: "var(--badge-update-shadow)" }}
          >
            立即更新
          </button>
        </div>
      </div>
    </div>
  );
}
