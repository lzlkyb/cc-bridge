import { Icon } from "../ui/icon";

/**
 * 关于卡的邀 Star（2026-10-17，学习 cc-switch AboutSection）。
 *
 * 未关闭时全卡呈「邀 Star 形态」：收起态 = 头部「★ 去点 Star」胶囊（StarPromptChip），
 * 展开态 = 琥珀 Star 信息行（StarPromptRow）；关闭后两处都退化为纯 GitHub 入口
 * （头部 GitHub 图标钮 / 仓库地址行）——入口不消失，只是收回推广形态。
 * 关闭记忆走 localStorage（纯界面偏好，参照 cc-switch：不进库、不随云同步）。
 * 静态星不做旋转：走项目 reduced-motion 克制纪律（cc-switch 的 6s 自转已省略）。
 */
const DISMISS_KEY = "ccbridge:about:starPromptDismissed";

export function readStarPromptDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissStarPrompt(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* 界面偏好，写失败不影响使用 */
  }
}

/** lucide star，实心琥珀——比描边星更有「可点亮」的邀请感。icon.tsx 尚无 star，先内联。 */
function StarGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
    </svg>
  );
}

/** 收起态：头部「★ 去点 Star」胶囊（与 34px GitHub 图标钮同高，amber 描边款）。 */
export function StarPromptChip({ onOpenRepo }: { onOpenRepo: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpenRepo}
      title="如果 CC Bridge 帮到了你，去 GitHub 点个 Star"
      className="flex h-[34px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-2.5 text-xs font-bold text-[#b45309] transition-colors hover:bg-[#f59e0b]/20 dark:text-[#fcd34d]"
    >
      <StarGlyph size={13} />
      去点 Star
    </button>
  );
}

const STYLE_ICON_AMBER = { background: "rgba(245,158,11,0.12)", color: "#F59E0B" };

/** 展开态：琥珀 Star 信息行（动机文案 + 去点 Star 标签 + × 关闭）。 */
export function StarPromptRow({
  dismissed,
  onDismiss,
  onOpenRepo,
}: {
  dismissed: boolean;
  onDismiss: () => void;
  onOpenRepo: () => void;
}) {
  if (dismissed) {
    return (
      <div className="info-row flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted">
        <div className="info-icon-wrap flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px]" style={STYLE_ICON_AMBER}>
          <Icon name="package" size={14} aria-hidden="true" />
        </div>
        <span className="info-key shrink-0 text-xs font-medium text-muted-foreground">仓库地址</span>
        <span className="info-val ml-auto text-right">
          <button
            type="button"
            onClick={onOpenRepo}
            className="info-tag info-tag-clickable tag-orange inline-block cursor-pointer rounded-md px-2 py-0.5 text-xs font-bold transition-[color,background-color,border-color,transform,box-shadow,opacity] hover:translate-y-[-1px] hover:shadow-hover"
          >
            GitHub ↗
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="info-row flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted">
      <div className="info-icon-wrap flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px]" style={STYLE_ICON_AMBER}>
        <StarGlyph size={15} />
      </div>
      <span className="info-key shrink-0 text-xs font-medium text-muted-foreground">如果 CC Bridge 帮到了你</span>
      <span className="info-val ml-auto flex items-center">
        <button
          type="button"
          onClick={onOpenRepo}
          className="info-tag info-tag-clickable tag-orange inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold transition-[color,background-color,border-color,transform,box-shadow,opacity] hover:translate-y-[-1px] hover:shadow-hover"
        >
          <StarGlyph size={11} />
          去点 Star ↗
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭邀 Star 提示"
          title="关闭"
          className="ml-1.5 flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </span>
    </div>
  );
}
