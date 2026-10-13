import type { CSSProperties } from "react";
import { Seg } from "./StatusSeg";
import type { StatusbarSkin } from "../../lib/terminalStatusbar";
import type { WheelOwner } from "../../lib/terminalScroll";

interface Props {
  skin: StatusbarSkin;
  /** 滚轮归属四态（hooks/useWheelGuide）。缺省 local：不出任何徽章（缺省态不占位）。 */
  owner: WheelOwner;
  /** ⚠ 徽章 aria-expanded（救急面板开合状态在父级）。 */
  deadBadgeExpanded?: boolean;
  /** ⚠ 徽章点击 → 打开救急面板。 */
  onDeadClick?: () => void;
  /** 翻转引导条收起后的「!」小徽章（点击重新展开）。 */
  guideHint?: boolean;
  onGuideHintClick?: () => void;
}

/**
 * 状态栏右侧的滚轮归属徽章组（设计稿《终端滚轮归属徽章与一键fullscreen》屏1）：
 * - forward：沿用既有「TUI 滚动」徽章（虚拟滚动条已激活）；
 * - forwardMain：信息徽章「滚轮→应用」，只说清归属、无面板（行为本就正确）；
 * - dead：⚠ 真按钮，点击弹救急面板——功能性告警，永不静音；
 * - guideHint：翻转引导条 10s 倒计时收起后的「!」小徽章，点击重新展开。
 * 断开态由调用方整体隐藏（closed 时不渲染本组件）。
 */
export function WheelOwnerBadge({
  skin,
  owner,
  deadBadgeExpanded,
  onDeadClick,
  guideHint,
  onGuideHintClick,
}: Props) {
  return (
    <>
      {owner === "forward" && (
        <Seg
          skin={skin}
          kind="tui"
          title="TUI 滚动已启用：拖动右侧滚动条即可滚动当前全屏程序（如 Claude Code）的内容"
        >
          TUI 滚动
        </Seg>
      )}
      {/* 主屏 × 跟踪开：xterm 原生把滚轮转发给程序（行为正确），只说清归属。 */}
      {owner === "forwardMain" && (
        <Seg
          skin={skin}
          kind="exit"
          title="当前程序开启了鼠标跟踪：滚轮正转发给它。Shift+滚轮可随时强制滚本地历史"
        >
          滚轮→应用
        </Seg>
      )}
      {owner === "dead" && <DeadSeg skin={skin} expanded={deadBadgeExpanded} onClick={onDeadClick} />}
      {guideHint && (
        <button
          type="button"
          onClick={onGuideHintClick}
          aria-label="展开滚轮归属提示"
          title="滚轮归属提示已收起，点击展开"
          className="grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full border border-warning/50 bg-warning/15 text-[10px] font-bold leading-none text-warning transition-colors hover:bg-warning/30"
        >
          !
        </button>
      )}
    </>
  );
}

/**
 * ⚠ 死滚轮徽章（DEAD 态）：真 <button>（键盘可达），warn 色胶囊底。
 * 非实心皮肤给半透明琥珀底做出「可点」的胶囊观感；实心（高对比）与其他段同规则。
 */
function DeadSeg({
  skin,
  expanded,
  onClick,
}: {
  skin: StatusbarSkin;
  expanded?: boolean;
  onClick?: () => void;
}) {
  const style: CSSProperties = { ...skin.seg, cursor: "pointer" };
  if (skin.solid) {
    style.background = skin.colors.warn;
    style.color = skin.text;
  } else {
    style.color = skin.colors.warn;
    style.background = "rgba(242,194,104,.14)";
    style.borderRadius = 4;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title="滚轮此刻不可用，点击查看救急办法"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      className="shrink-0 whitespace-nowrap"
      style={style}
    >
      ⚠ 滚轮不可用
    </button>
  );
}
