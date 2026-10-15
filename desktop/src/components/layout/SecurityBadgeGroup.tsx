import { useMemo } from "react";
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
 * warning 系。全部隐藏时整枚不渲染（正常态顶栏安静）。
 */
export function SecurityBadgeGroup({
  badges,
  onNavigate,
}: {
  badges: SecurityBadge[];
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const visible = useMemo(() => badges.filter((b) => b.show), [badges]);
  const danger = visible.some((b) => b.danger);
  if (visible.length === 0) return null;

  const label = `${visible.length} 项${danger ? "安全" : ""}提醒`;
  return (
    <Menu
      align="left"
      width="w-72"
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          title={visible.map((b) => b.label).join("、")}
          className={`inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold transition-colors ${
            danger
              ? "border-destructive/30 bg-destructive/10 text-destructive-ink hover:bg-destructive/20"
              : "border-warning/30 bg-warning/10 text-warning-ink hover:bg-warning/20"
          }`}
        >
          <Icon name={danger ? "alertTriangle" : "lock"} size={11} />
          {label}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-2.5 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground">
            安全状态 · 点击前往处理
          </div>
          {visible.map((b) => (
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
  );
}
