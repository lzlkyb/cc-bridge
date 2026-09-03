import { Icon } from "../ui/icon";

interface Props {
  count: number;
  /**
   * 目标目录；`undefined` = 本区域不承诺目录（终端）。
   *
   * 文案分两种是故意的：文件面板能直接报出目录（它就写在路径条上），
   * 而终端的 cwd 我们确实不知道，就不能假装知道。
   */
  dir?: string;
  /** 正在传输 / 确认框开着：接不了新的一批。 */
  busy?: boolean;
}

/** 拖入时盖在面板/终端上的提示层。 */
export function SshDropOverlay({ count, dir, busy }: Props) {
  // 🔴 忙的时候照样出遮罩，只是换成灰色 + 说清楚原因。
  // 以前是直接不收集拖放区，遮罩不出、也不提示，用户只知道「没反应」。
  if (busy) {
    return (
      <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border bg-background/70 backdrop-blur-[1px]">
        <span className="flex items-center gap-1.5 text-sm font-bold text-muted-foreground">
          <Icon name="spinner" size={15} className="animate-spin" />
          正在传输，请稍候
        </span>
        <span className="text-xs text-muted-foreground">当前批完成后再拖入</span>
      </div>
    );
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-[1px]">
      <span className="flex items-center gap-1.5 text-sm font-bold text-primary">
        <Icon name="upload" size={15} />
        {dir === undefined
          ? "松手选择上传位置"
          : `松手上传 ${count} 个文件`}
      </span>
      {dir === undefined ? (
        <span className="text-xs text-muted-foreground">
          终端当前目录无法探知，需要你确认一下
        </span>
      ) : (
        <code className="max-w-[80%] truncate rounded-md border border-border bg-card px-2.5 py-1 text-xs">
          {dir}
        </code>
      )}
    </div>
  );
}
