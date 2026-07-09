import { useUpdate } from "../../contexts/UpdateContext";
import { Icon } from "../ui/icon";

/**
 * Header 上的更新状态徽章：仅在有新版本 / 待重启两种状态时显示，
 * 其余状态（idle / checking / downloading / error）由 UpdateGroup 完整面板处理。
 */
export function UpdateBadge() {
  const { status, update } = useUpdate();

  if (status === "available") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
        <Icon name="arrowUp" size={11} />
        有新版本{update ? ` v${update.version}` : ""}
      </span>
    );
  }

  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
        <Icon name="check" size={11} />
        待重启
      </span>
    );
  }

  return null;
}
