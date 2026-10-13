import { useState, useCallback } from "react";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus, BackupListResult, BackupFileInfo } from "../../../lib/types";
import { formatBytes } from "../../../lib/utils";
import { VersionHistoryModal } from "../../backup/VersionHistoryModal";
import { BackupCleanupDialog } from "../../backup/BackupCleanupDialog";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { toast } from "../../ui/toast";
import { InlineNum } from "../../ui/InlineNum";
import { SumRow } from "../../ui/SumRow";
import { RestoreBackupDialog } from "../RestoreBackupDialog";

/**
 * 「文件管控」卡的备份展开区（SumRow 折叠态之下）。
 *
 * 从 FileControlCard 拆出：备份一节自带五个状态（备份列表 / 懒加载 / 版本历史弹窗 /
 * 还原目标 / 清理弹窗）+ 三个副作用函数，留在主文件里会把 301 行的主卡继续推胖。
 * 保存通道（saveField / lastSavedField）由父组件传入——扩展名与限流节共用同一份。
 */
export function BackupSection({
  status,
  onSaved,
  saveField,
  lastSavedField,
}: {
  status?: StaticStatus;
  onSaved: () => void;
  saveField: (patch: Record<string, unknown>, fieldName: string) => Promise<void>;
  lastSavedField: string;
}) {
  const [backups, setBackups] = useState<BackupListResult | null>(null);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoreEntry, setRestoreEntry] = useState<BackupFileInfo | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const loadBackups = useCallback(async () => {
    setLoadingBackups(true);
    try {
      const r = await invoke<BackupListResult>("list_backups");
      setBackups(r);
    } catch (e) {
      toast(`加载备份列表失败：${e}`, "error");
    } finally {
      setLoadingBackups(false);
    }
  }, []);

  /**
   * 删掉备份后统一走这里：刷新占用统计 + 处理备份列表缓存。
   *
   * 版本历史**正开着**时必须重新拉取，不能只把缓存置 null：列表只在点「打开」
   * 时懒加载，置 null 后没人重拉，弹框会直接变成「暂无备份文件」的空态
   * （`isEmpty = !loading && !result`）——删了一份却看起来像全没了。
   */
  const invalidateBackups = useCallback(() => {
    onSaved();
    if (historyOpen) {
      void loadBackups();
    } else {
      setBackups(null);
    }
  }, [onSaved, historyOpen, loadBackups]);

  const handleOpenBackupDir = async () => {
    try {
      await invoke("reveal_backup_dir");
    } catch (e) {
      toast(`打开备份目录失败：${e}`, "error");
    }
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    // 首次打开时懒加载（不占首屏），之后复用缓存
    if (!backups && !loadingBackups) {
      await loadBackups();
    }
  };

  return (
    <div className="space-y-2.5 px-2.5 pb-2">
      <div className="s-row group">
        <span className="title-chip"><Icon name="file" size={15} aria-hidden="true" /></span>
        <div className="s-body">
          <div className="s-label">文件大小上限</div>
          <div className="s-row-desc">超过上限的文件自动截断</div>
        </div>
        <div className="s-right">
          <InlineNum
            value={status ? Math.round(status.maxFileSizeBytes / 1024 / 1024) : 20}
            saved={lastSavedField === "maxFileSize"}
            unit="MB"
            ariaLabel="文件大小上限（MB）"
            onSave={(v) => saveField({ maxFileSizeBytes: v * 1024 * 1024 }, "maxFileSize")}
          />
        </div>
      </div>

      <div className="s-row-divider" />

      <div className="s-row group">
        <span className="title-chip"><Icon name="history" size={15} aria-hidden="true" /></span>
        <div className="s-body">
          <div className="s-label">备份保留份数</div>
          <div className="s-row-desc">
            同一文件最多保留最近 N 份（按编辑次数累积，
            <span className="font-medium text-foreground">非按天</span>）
          </div>
        </div>
        <div className="s-right">
          <InlineNum
            value={status?.backupRetention ?? 10}
            saved={lastSavedField === "backupRetention"}
            unit="份"
            ariaLabel="备份保留份数"
            onSave={(v) => saveField({ backupRetention: v }, "backupRetention")}
          />
        </div>
      </div>

      <div className="s-row-divider" />

      <div className="s-row group">
        <span className="title-chip"><Icon name="folder" size={15} aria-hidden="true" /></span>
        <div className="s-body">
          <div className="s-label">备份目录</div>
          <div className="s-row-desc font-mono text-[11px] break-all" title={status?.backupDirAbs}>
            {status?.backupDirAbs || status?.backupDir || "未设置"}
          </div>
        </div>
        <div className="s-right">
          <Button
            variant="outline"
            size="sm"
            onClick={handleOpenBackupDir}
            disabled={!status?.backupDirAbs}
          >
            <Icon name="folder" size={14} />
            打开文件夹
          </Button>
        </div>
      </div>
      <p className="s-row-desc px-2.5 pb-1 text-[10.5px]">
        备份仅存于本机该目录，远程 Claude Code 无法读取；目录名由程序固定管理，无需手动修改。
      </p>

      {/* 实时统计 + 规则说明 */}
      <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
        <span>
          共 <span className="font-semibold">{status?.backupCount ?? 0}</span> 个备份 · 占用{" "}
          <span className="font-semibold">{formatBytes(status?.backupTotalBytes ?? 0)}</span>
        </span>
        {/* 面板上原本根本没有删备份的入口，唯一办法是「打开文件夹」自己手删——
            而手删不会清 backup_index，会留孤儿索引行。 */}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          onClick={() => setCleanupOpen(true)}
        >
          <Icon name="trash" size={14} />
          清理备份…
        </Button>
      </div>

      <BackupCleanupDialog
        open={cleanupOpen}
        onClose={() => setCleanupOpen(false)}
        onDone={invalidateBackups}
      />
      <div className="flex gap-2.5 rounded-lg border border-primary/25 bg-primary/10 p-3 text-xs leading-relaxed text-foreground">
        <Icon name="info" size={15} className="mt-0.5 shrink-0 text-primary" />
        <div>
          <b className="text-primary">备份怎么产生的？</b> 你（或远程会话）每次
          <b>改写 / 删除一个已存在的受保护文件</b>前，程序会自动把原文件复制一份到上面的目录，命名为
          <code className="mx-0.5 rounded bg-background/60 px-1 font-mono text-[11px]">原文件名.时间戳.bak</code>
          。同一文件被改多次会留多个版本，<b>只按份数保留最近 N 份，与日期无关</b>。
        </div>
      </div>

      {/* 版本历史：动作行（无展开态，点它直接开弹窗）。放在备份节内——它是备份的
          子功能，且弹窗 state（historyOpen/backups）就在本组件，拆去卡片级要靠
          nonce 跨组件唤醒，平白多一层间接。原「外层 button 内嵌 Button」的非法
          DOM 嵌套也随之消解：整行就是一个 button，不再需要内层按钮。 */}
      <SumRow
        icon="history"
        label="版本历史"
        value="浏览备份快照 · 查看改动 · 对比相邻版本 · 还原"
        onToggle={openHistory}
      />

      <VersionHistoryModal
        open={historyOpen}
        status={status}
        result={backups}
        loading={loadingBackups}
        onClose={() => setHistoryOpen(false)}
        onRestore={(entry) => setRestoreEntry(entry)}
        onDeleted={invalidateBackups}
      />

      {restoreEntry && (
        <RestoreBackupDialog entry={restoreEntry} onClose={() => setRestoreEntry(null)} />
      )}
    </div>
  );
}
