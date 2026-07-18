import { useState, useCallback } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult, BackupListResult, BackupFileInfo } from "../../lib/types";
import { formatBytes } from "../../lib/utils";
import { VersionHistoryModal } from "../backup/VersionHistoryModal";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { ChipInput } from "../ui/chip-input";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { InlineNum } from "../ui/InlineNum";
import { RestoreBackupDialog } from "./RestoreBackupDialog";

/**
 * 「文件管控」卡：扩展名限制、备份（统计/路径/版本历史）、请求限流、后台命令清理。
 * 相关状态（保存反馈、备份列表、版本历史、还原目标）内聚于此，避免主文件膨胀。
 */
export function FileControlCard({ status, onSaved }: { status?: StatusResponse; onSaved: () => void }) {
  const [lastSavedField, setLastSavedField] = useState("");
  const [backups, setBackups] = useState<BackupListResult | null>(null);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoreEntry, setRestoreEntry] = useState<BackupFileInfo | null>(null);

  const handleOpenBackupDir = async () => {
    try {
      await invoke("reveal_backup_dir");
    } catch (e) {
      console.error("[备份] 打开目录失败:", e);
    }
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    // 首次打开时懒加载（不占首屏），之后复用缓存
    if (!backups && !loadingBackups) {
      setLoadingBackups(true);
      try {
        const r = await invoke<BackupListResult>("list_backups");
        setBackups(r);
      } catch (e) {
        console.error("[备份] 列出失败:", e);
      } finally {
        setLoadingBackups(false);
      }
    }
  };

  const showSaved = useCallback((field: string) => {
    setLastSavedField(field);
    setTimeout(() => setLastSavedField(""), 1500);
  }, []);

  const saveField = useCallback(
    async (patch: Record<string, unknown>, fieldName: string) => {
      await invoke<ConfigSaveResult>("save_config", { patch });
      onSaved();
      showSaved(fieldName);
    },
    [onSaved, showSaved],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="shield" />}>文件管控</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <ChipInput
            value={status?.allowedExtensions ?? []}
            onChange={(vals) => {
              saveField({ allowedExtensions: vals }, "extensions");
            }}
          />
          <p className="text-xs text-muted-foreground">
            留空表示不限制扩展名；所有设置修改后自动保存。
          </p>
        </div>

        <div className="my-3.5 h-px bg-border" />

        {/* ══ 备份 — PastePanda 行式 ══ */}
        <div className="s-sec-label">备份</div>

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
        <div className="mt-1 flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>
            共 <span className="font-semibold">{status?.backupCount ?? 0}</span> 个备份 · 占用{" "}
            <span className="font-semibold">{formatBytes(status?.backupTotalBytes ?? 0)}</span>
          </span>
        </div>
        <div className="mt-2.5 flex gap-2.5 rounded-lg border border-primary/25 bg-primary/10 p-3 text-xs leading-relaxed text-foreground">
          <Icon name="info" size={15} className="mt-0.5 shrink-0 text-primary" />
          <div>
            <b className="text-primary">备份怎么产生的？</b> 你（或远程会话）每次
            <b>改写 / 删除一个已存在的受保护文件</b>前，程序会自动把原文件复制一份到上面的目录，命名为
            <code className="mx-0.5 rounded bg-background/60 px-1 font-mono text-[11px]">原文件名.时间戳.bak</code>
            。同一文件被改多次会留多个版本，<b>只按份数保留最近 N 份，与日期无关</b>。
          </div>
        </div>

        {/* 版本历史：打开居中弹框（检索/导航 + 版本时间线 + 相邻对比 + 还原） */}
        <button
          type="button"
          className="mt-3 flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-3 text-left transition-colors hover:bg-muted"
          onClick={openHistory}
        >
          <span className="title-chip">
            <Icon name="history" size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-foreground">版本历史</div>
            <div className="truncate text-[11px] text-muted-foreground">
              浏览备份快照 · 查看改动 · 对比相邻版本 · 还原
            </div>
          </div>
          <Button variant="outline" size="sm">
            打开
          </Button>
        </button>

        <VersionHistoryModal
          open={historyOpen}
          status={status}
          result={backups}
          loading={loadingBackups}
          onClose={() => setHistoryOpen(false)}
          onRestore={(entry) => setRestoreEntry(entry)}
        />

        <div className="my-3.5 h-px bg-border" />

        {/* ══ 请求限流 — PastePanda 合并行 ══ */}
        <div className="s-sec-label">请求限流</div>

        <div className="s-row group">
          <span className="title-chip"><Icon name="sliders" size={15} aria-hidden="true" /></span>
          <div className="s-body">
            <div className="s-label">请求限制</div>
            <div className="s-row-desc">
              当前：每 {status ? status.rateLimit.windowMs / 1000 : 60}s 最多 {status?.rateLimit.maxRequests ?? 100} 次，超出拒绝
            </div>
          </div>
          <div className="s-right">
            <InlineNum
              value={status?.rateLimit.maxRequests ?? 100}
              saved={lastSavedField === "rateMaxReq"}
              unit="次 /"
              onSave={(v) => saveField({ rateLimitMaxRequests: v }, "rateMaxReq")}
            />
            <InlineNum
              value={status ? status.rateLimit.windowMs / 1000 : 60}
              saved={lastSavedField === "rateWindow"}
              unit="秒"
              onSave={(v) => saveField({ rateLimitWindowMs: v * 1000 }, "rateWindow")}
            />
          </div>
        </div>

        <div className="my-3.5 h-px bg-border" />

        {/* ══ 后台命令清理 ══ */}
        <div className="s-sec-label">后台命令</div>
        <div className="s-row group">
          <span className="title-chip"><Icon name="terminal" size={15} aria-hidden="true" /></span>
          <div className="s-body">
            <div className="s-label">结束后保留时长</div>
            <div className="s-row-desc">
              命令执行结束后在面板保留一段时间（供查看最终输出），超时自动清除。设为 0 则立即清除。
            </div>
          </div>
          <div className="s-right">
            <InlineNum
              value={status?.commandCleanupSecs ?? 120}
              saved={lastSavedField === "cleanupSecs"}
              unit="秒"
              onSave={(v) => saveField({ commandCleanupSecs: v }, "cleanupSecs")}
            />
          </div>
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">
          所有设置修改后自动保存，无需手动提交。
        </p>
      </CardContent>

      {restoreEntry && (
        <RestoreBackupDialog entry={restoreEntry} onClose={() => setRestoreEntry(null)} />
      )}
    </Card>
  );
}
