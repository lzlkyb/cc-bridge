import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";

interface Props {
  /** 当前目录（过滤后）条目总数——未选中时计数槽显示「共 N 项」。 */
  total: number;
  /** 已选条目数（含目录；按 view 口径，只算列表里还看得见的）。 */
  selected: number;
  /** 原始选择是否非空——含被过滤隐藏掉的。只用来判「取消选择」能不能点：
   *  选择本身与过滤无关，不能因为过滤到 0 命中就变得清不掉。 */
  hasSelection: boolean;
  /** 选中条目中普通文件的数量——下载与删除都只对文件有意义。 */
  files: number;
  downloadable?: number;
  downloadTarget?: string;
  downloadLabel?: string;
  busy: boolean;
  onDownload: () => void;
  onRemove: () => void;
  /** 移动到别的目录（含目录条目——批量移动不挑类型）。 */
  onMove: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}

/**
 * 多选批量操作条：常驻在文件列表上方（不遮列表）。
 *
 * WHY 常驻而不是「选了才出现」：条件挂载会让列表整体上下位移一行，用户第一次
 * 点文件时看的行会跳走（尤其刚想点第二行时跳成别的行）。常驻后三种状态下批量条
 * 高度恒定、列表首行位置不变，代价是空态多占一行。
 * WHY 未选中时计数槽说「共 N 项」而不是「已选 0 个」：前者是有用信息（目录规模），
 * 后者是噪声；两段文案都由「3 个汉字 + 数字」构成，宽度一致，切换不改换行。
 * 下载可包含目录。批量删除只接受文件，递归删除继续走目录行的单独确认。
 */
export function FileBatchBar({ total, selected, hasSelection, files, downloadable = files, downloadTarget, downloadLabel = "下载所选", busy, onDownload, onRemove, onMove, onSelectAll, onClear }: Props) {
  const picking = selected > 0;
  return (
    <div
      role="toolbar"
      aria-label="批量操作"
      data-selected={picking}
      className={`file-batch-bar flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors ${
        picking ? "bg-primary/5" : "bg-muted/25"
      }`}
    >
      {/* 固定 64px 计数槽：两种文案宽度一致，状态切换不推挤按钮，窄面板下换行行数也一致 */}
      <span className="w-16 shrink-0 whitespace-nowrap tabular-nums">
        {picking ? `已选 ${selected} 个` : `共 ${total} 项`}
      </span>
      <button
        type="button"
        disabled={busy || downloadable === 0}
        onClick={onDownload}
        className="shrink-0 whitespace-nowrap rounded-md bg-primary px-2 py-1 text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
      >
        {downloadLabel}{downloadable !== selected && selected > 0 ? `（${downloadable} 项）` : ""}
      </button>
      {downloadTarget && <span className="file-download-target min-w-0 flex-1 truncate" title={downloadTarget}>至 {downloadTarget}</span>}
      <button
        type="button"
        disabled={busy || files === 0}
        onClick={onRemove}
        className="file-batch-wide shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-destructive-ink hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        删除所选
      </button>
      <button
        type="button"
        disabled={busy || selected === 0}
        onClick={onMove}
        className="file-batch-wide shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        移动到…
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onSelectAll}
        className="file-batch-wide shrink-0 whitespace-nowrap rounded-md px-2 py-1 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        全选
      </button>
      <button
        type="button"
        disabled={!hasSelection}
        onClick={onClear}
        className="file-batch-wide ml-auto shrink-0 whitespace-nowrap rounded-md px-2 py-1 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        取消选择
      </button>
      <div className="file-batch-compact hidden shrink-0">
        <Menu portal trigger={(expanded, toggle) => <Button size="sm" variant="ghost" className="h-6 px-2"
          aria-expanded={expanded} aria-haspopup="menu" onClick={toggle}><Icon name="more" size={14}/>批量操作</Button>}>
          {close => <>
            <MenuItem label="全选" disabled={busy} onClick={() => { close(); onSelectAll(); }}/>
            <MenuItem label="取消选择" disabled={!hasSelection} onClick={() => { close(); onClear(); }}/>
            <MenuItem label="移动到…" disabled={busy || selected === 0} onClick={() => { close(); onMove(); }}/>
            <MenuItem label="删除所选" disabled={busy || files === 0} onClick={() => { close(); onRemove(); }}/>
          </>}
        </Menu>
      </div>
    </div>
  );
}
