import { Icon } from "../ui/icon";
import type { SshFileEntry } from "../../lib/types";

interface Props {
  entry: SshFileEntry;
  /** 可进入（目录 / 软链到目录）。 */
  clickable: boolean;
  busy: boolean;
  /** 预判可读；`false` 时渲染锁图标 + 「你不可读」徽标。 */
  canRead: boolean;
  /** 不可读时的完整 title（属主/权限/出路），由 `utils.unreadEntryTitle` 生成。 */
  unreadTitle?: string;
  selected?: boolean;
  onToggleSelected?: () => void;
  onOpenDir: (name: string) => void;
}

/**
 * 文件行的「名称」单元格：图标 + 名字（目录/软链到目录是按钮）+ 软链目标 + 不可读预标。
 *
 * 为什么从 `SshFileRow` 抽出来：组件体量门禁是 300 行/文件，行组件已贴线
 * （296 行），而预标要在这个单元格里加锁图标、徽标、title 三处。
 *
 * 预标三件套（设计稿 design/SSH文件面板-不可读预标与诊断复制-设计稿-2026-11-24.html）：
 * ① 锁图标**替换**文件图标（warning 色）——扫描时锁形是最快的识别符号，不叠加；
 * ② 「你不可读」徽标——把主体说清楚：不是文件坏了，是你这个身份不行；
 * ③ 名字降为弱色 + title 给完整诊断（属主/属组/权限/出路）。
 *
 * 名字保持可见、按钮不让位：删除看的是目录 w 位（可能成功），双击失败的读路径
 * 也带同款诊断——预标只负责「提前告知」，不替用户拿主意。
 *
 * ⚠️ 软链按**条目级语义**判：`canRead` 由调用方基于链接自身的 mode 算（恒 0777 左右），
 * 目标可读性交给读失败的诊断，两套语义不混。
 */
export function SshFileNameCell({
  entry,
  clickable,
  busy,
  canRead,
  unreadTitle,
  selected,
  onToggleSelected,
  onOpenDir,
}: Props) {
  return (
    <td className="max-w-[340px] py-1.5 pl-3">
      <span className="flex min-w-0 items-center gap-2 text-left">
        {onToggleSelected && <input type="checkbox" checked={!!selected} disabled={busy}
          className="shrink-0 accent-primary" aria-label={`选择 ${entry.name}`}
          onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
          onChange={onToggleSelected}/>}
        {canRead ? (
          <Icon
            name={clickable ? "folder" : "file"}
            size={15}
            className={`shrink-0 ${clickable ? "text-blue-500" : "text-muted-foreground"}`}
          />
        ) : (
          <Icon
            name="lock"
            size={15}
            className="shrink-0 text-warning"
            aria-label="你不可读"
          />
        )}
        {clickable ? (
          <button
            type="button"
            disabled={busy}
            title={entry.name}
            aria-label={`打开文件夹 ${entry.name}`}
            className="min-w-0 truncate rounded text-left font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            onClick={(event) => {
              event.stopPropagation();
              onOpenDir(entry.name);
            }}
          >
            {entry.name}
          </button>
        ) : (
          <span
            className={`min-w-0 truncate ${canRead ? "" : "text-muted-foreground"}`}
            title={unreadTitle ?? entry.name}
          >
            {entry.name}
          </span>
        )}
        {!canRead && (
          <span
            className="shrink-0 rounded-[4px] border border-warning/30 bg-warning/15 px-1.5 py-[1px] text-[10.5px] leading-tight text-warning-ink"
            title={unreadTitle}
          >
            你不可读
          </span>
        )}
        {entry.isSymlink &&
          (entry.linkTarget ? (
            <span
              className="shrink-0 max-w-[160px] truncate text-[11px] text-muted-foreground"
              title={`${entry.name} → ${entry.linkTarget}`}
            >
              → {entry.linkTarget}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground">链接</span>
          ))}
      </span>
    </td>
  );
}
