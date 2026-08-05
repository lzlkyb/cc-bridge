import type { RootProfile } from "../../lib/types";
import { Icon } from "../ui/icon";

/**
 * 白名单「配置组」的**收起态胶囊**，放在「白名单根目录」卡的标题行。
 * 设计稿：design/白名单配置组入标题行-设计稿.html（方案 B）
 *
 * 为何与 RootProfilePanel 拆成两个组件：胶囊在 `CardHeader`、展开面板在 `CardContent`，
 * 两者不在同一 DOM 位置，一个组件没法同时渲染到两处。它们之间共享的只有「是否展开」
 * 这一个状态，由 SecurityTab 持有；面板自己那堆状态（新建 / 重命名 / 删除确认 / busy）
 * 仍留在面板内部。
 *
 * 为何压成胶囊、而不是把原来那条整体搬上标题行：整条约 213px 宽，标题行总宽会到 ~613px，
 * 窗口缩到最小（卡宽 520）时 `CardHeader` 的 `flex-wrap` 会折成两行——省下的 60px 又还
 * 回去了。胶囊约 110px，总宽 ~510px，任何宽度下都是单行。
 */
export function RootProfilePill({
  profiles,
  active,
  open,
  onToggle,
}: {
  profiles: RootProfile[];
  active: string;
  open: boolean;
  onToggle: () => void;
}) {
  const current = profiles.find((p) => p.name === active);

  return (
    <button
      type="button"
      onClick={onToggle}
      title="切换白名单配置组"
      aria-expanded={open}
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-semibold"
    >
      {/* 组名可能很长，截断而不是把标题行顶宽 */}
      <span className="max-w-[120px] truncate">{active || "—"}</span>
      {current && (
        <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
          · {current.roots.length} 个目录
        </span>
      )}
      {/* 图标集里只有 chevronDown，展开态用旋转表达，不为此新增图标。 */}
      <Icon
        name="chevronDown"
        size={11}
        className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
      />
    </button>
  );
}
