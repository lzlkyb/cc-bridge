import { CATEGORY_LABELS, type ChangeCategory } from "../../lib/about";

const classes: Record<ChangeCategory, string> = {
  feat: "cl-badge-feat", improve: "cl-badge-improve", fix: "cl-badge-fix", sec: "cl-badge-sec",
};
const categories = new Map(Object.entries(CATEGORY_LABELS).map(([key, label]) => [label, key as ChangeCategory]));

/** Settings and the update dialog share the same category treatment in every theme. */
export function ChangelogBadge({ category, label }: { category?: ChangeCategory; label?: string }) {
  const resolved = category ?? categories.get(label ?? "");
  return <span className={`cl-badge shrink-0 rounded px-1.5 text-[10px] leading-relaxed font-extrabold tracking-wider whitespace-nowrap ${resolved ? classes[resolved] : "bg-muted text-muted-foreground"}`}>
    {label ?? (resolved ? CATEGORY_LABELS[resolved] : "更新")}
  </span>;
}
