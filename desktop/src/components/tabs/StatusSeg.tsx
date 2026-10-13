import type { CSSProperties } from "react";
import type { IconName } from "../ui/icon";
import { Icon } from "../ui/icon";
import type { SegKind, StatusbarSkin } from "../../lib/terminalStatusbar";

/**
 * 状态栏段原语（Seg + Divider），从 TerminalStatusBar 拆出：
 * 滚轮归属徽章组（WheelOwnerBadge）也要按同一套皮肤规则画段，共用这里。
 *
 * WHY 段色走内联 style 而不是 CSS 类：四套风格 × 亮/暗 = 8 套 token，
 * 写成 CSS 类就得往 `index.css` 里塞 8 个选择器块。token 集中在 `lib/terminalStatusbar.ts`。
 */
export function Seg({
  skin,
  kind,
  icon,
  title,
  isFirst,
  children,
}: {
  skin: StatusbarSkin;
  kind: SegKind;
  icon?: IconName;
  title?: string;
  /** 首个段（host）之前不画分隔线，避免依赖 DOM 顺序的 nth-of-type 魔法。 */
  isFirst?: boolean;
  children: React.ReactNode;
}) {
  const style: CSSProperties = { ...skin.seg };
  if (skin.solid) {
    style.background = skin.colors[kind];
    style.color = skin.text;
  } else {
    style.color = skin.colors[kind];
  }
  return (
    <>
      {!isFirst && <Divider skin={skin} />}
      {/* shrink-0 + nowrap：段宁可横向滚动（左区 overflow-x-auto）也不许折行撑高状态栏 */}
      <span style={style} title={title} className="shrink-0 whitespace-nowrap">
        {skin.icons && icon && <Icon name={icon} size={11} />}
        {children}
      </span>
    </>
  );
}

/**
 * 段间分隔：靖蓝/高对比用竖线（高对比是色块，靠 margin 分开，不再画线），
 * 极简用 `·`、经典用 `│`。首段之前不画 —— 由 Seg 的 `isFirst` 控制，不靠 CSS 选择器猜顺序。
 */
function Divider({ skin }: { skin: StatusbarSkin }) {
  if (skin.solid) return null;
  if (skin.divider === null) {
    return (
      <span
        aria-hidden
        className="h-3 w-px shrink-0"
        style={{ background: skin.dividerColor }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{ color: skin.dividerColor }}
    >
      {skin.divider}
    </span>
  );
}
