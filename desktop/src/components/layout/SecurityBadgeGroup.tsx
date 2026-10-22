import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";

export interface SecurityBadge {
  key: string;
  show: boolean;
  label: string;
  icon: IconName;
  danger: boolean;
  tab: string;
  anchor?: string;
  title: string;
}

/**
 * 顶栏安全徽章聚合（C 方案，2026-10-15）：最多 5 枚散徽章折成 1 枚入口。
 *
 * WHY 聚合：徽章群紧邻侧栏开关与服务启停两个高危邻居，窄窗下弹性空白被压没后
 * 徽章直接顶上「停止服务」，误触代价重；聚合后顶栏可点目标从 5 变 1，窄窗也
 * 不再溢出。面板内每项保留完整语义（图标 + 文案 + 点击直达处置页），跳转逻辑
 * 复用原徽章的 tab/anchor。
 *
 * 配色取组内最高危级：有 danger 项 → destructive 系；仅 warn 级（如只读）→
 * warning 系。
 *
 * 槽位化（2026-10-17，与更新徽章同款病灶同款修法）：无提醒时不再 `return null`——
 * 整枚徽章硬切出现/消失会把顶栏中段一瞬间推挤。改住 `.sec-slot` 槽位列
 * （grid 0fr→1fr，280ms 平滑展开/收起，样式在 interaction-refinements.css）。
 * - `held`：退场后保留最后一批徽章渲染，收起动画不播空气（Collapse 的 visited 同思路，
 *   稳态隐藏时内容 0 宽 + opacity 0 + inert，无副作用）；
 * - `clip`：Menu 弹层向下伸展，槽位**不能常驻 overflow 裁剪**（会切掉下拉面板），
 *   只在展开/收起的 300ms 动画窗口内裁横向，稳态放开。
 */
export function SecurityBadgeGroup({
  badges,
  onNavigate,
  compact = false,
}: {
  badges: SecurityBadge[];
  onNavigate?: (tab: string, anchor?: string) => void;
  compact?: boolean;
}) {
  const visible = useMemo(() => badges.filter((b) => b.show), [badges]);
  const hasAny = visible.length > 0;

  // ⚠️ 两个 layout effect 都只挂 [hasAny]，不能挂 visible：badges 数组在 Header 里
  // 未 memo，每 5s 轮询都是新身份——挂 visible 会让 clip 定时器被反复重置，
  // 弹层永远处于被裁剪状态。最后一次非空列表走 ref 捕获。
  const lastShownRef = useRef<SecurityBadge[] | null>(null);
  if (hasAny) lastShownRef.current = visible;

  const [held, setHeld] = useState<SecurityBadge[] | null>(null);
  const [clip, setClip] = useState(true);
  useLayoutEffect(() => {
    // layout effect：在收起的首帧绘制前就补上 held，屏幕看不到空槽帧。
    if (!hasAny) setHeld(lastShownRef.current);
  }, [hasAny]);
  useLayoutEffect(() => {
    setClip(true);
    const t = setTimeout(() => setClip(false), 300);
    return () => clearTimeout(t);
  }, [hasAny]);

  const shown = hasAny ? visible : held;
  const count = shown?.length ?? 0;
  const anyDanger = !!shown?.some((b) => b.danger);

  return (
    <div
      className={`sec-slot ${compact ? "terminal-fullscreen-safety" : ""}`}
      data-open={hasAny}
      data-clip={clip || undefined}
      aria-hidden={!hasAny}
      ref={(n) => {
        if (n) n.inert = !hasAny;
      }}
    >
      <div className="sec-slot-item">
        {shown && (
          <Menu
            align={compact ? "right" : "left"}
            portal={compact}
            width="w-72"
            trigger={(open, toggle) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-haspopup="menu"
                aria-label={compact ? `${count} 项${anyDanger ? "安全" : ""}提醒` : undefined}
                title={shown.map((b) => b.label).join("、")}
                className={`inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold transition-colors ${
                  anyDanger
                    ? "border-destructive/30 bg-destructive/10 text-destructive-ink hover:bg-destructive/20"
                    : "border-warning/30 bg-warning/10 text-warning-ink hover:bg-warning/20"
                }`}
              >
                <Icon name={compact ? "shield" : anyDanger ? "alertTriangle" : "lock"} size={compact ? 15 : 11} />
                {/* 计数位锁宽：1↔2 位数变化不横推「项…提醒」文字与右侧中段。 */}
                <span className="min-w-[1.3ch] text-center tabular-nums">{count}</span>
                {!compact && <>项{anyDanger ? "安全" : ""}提醒</>}
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="px-2.5 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground">
                  安全状态 · 点击前往处理
                </div>
                {shown.map((b) => (
                  <MenuItem
                    key={b.key}
                    icon={b.icon}
                    label={
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate">{b.label}</span>
                        <span className="truncate text-xs text-muted-foreground">{b.title}</span>
                      </span>
                    }
                    trailing={<Icon name="chevronLeft" size={13} className="rotate-180 text-muted-foreground" />}
                    onClick={() => {
                      onNavigate?.(b.tab, b.anchor);
                      close();
                    }}
                  />
                ))}
              </>
            )}
          </Menu>
        )}
      </div>
    </div>
  );
}
