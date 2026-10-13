import { useState, useCallback } from "react";
import { invoke } from "../../lib/tauri";
import type { StaticStatus, ConfigSaveResult } from "../../lib/types";
import { formatBytes } from "../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { ChipInput } from "../ui/chip-input";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { SumRow } from "../ui/SumRow";
import { BackupSection } from "./filecontrol/BackupSection";
import { RateLimitSection, CleanupSection } from "./filecontrol/LimitSections";

/**
 * 「文件管控」卡：扩展名限制 + 备份 / 请求限流 / 后台命令三节（渐进披露）。
 *
 * 2026-10-13（P1-3 过载修复）：三节由铺开的 9 个控件改为 SumRow 摘要行——
 * 当前值常驻可见，整行是键盘可达的 button（aria-expanded / ↑↓ / Enter+Space），
 * 展开才落细项控件。首屏交互元素 9→5。展开区拆到 filecontrol/ 下两个子组件
 * （备份一节状态多，限流/清理是纯展示），本文件回到 300 行棘轮之内。
 */
export function FileControlCard({ status, onSaved }: { status?: StaticStatus; onSaved: () => void }) {
  const [lastSavedField, setLastSavedField] = useState("");
  // 三个展开节的开关（备份 / 限流 / 清理）。
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleSection = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const showSaved = useCallback((field: string) => {
    setLastSavedField(field);
    setTimeout(() => setLastSavedField(""), 1500);
  }, []);

  const saveField = useCallback(
    async (patch: Record<string, unknown>, fieldName: string) => {
      try {
        await invoke<ConfigSaveResult>("save_config", { patch });
        onSaved();
        showSaved(fieldName);
      } catch (e) {
        toast(`保存失败：${e}`, "error");
      }
    },
    [onSaved, showSaved],
  );

  const windowSec = status ? status.rateLimit.windowMs / 1000 : 60;

  return (
    <Card id="set-backup">
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

        {/* ══ 备份：摘要行 ↔ 展开态 ══ */}
        <SumRow
          icon="history"
          label="备份"
          value={`共 ${status?.backupCount ?? 0} 个备份 · 占用 ${formatBytes(status?.backupTotalBytes ?? 0)} · 保留最近 ${status?.backupRetention ?? 10} 份 · 目录 ${status?.backupDirAbs || status?.backupDir || "未设置"}`}
          expanded={expanded.has("backup")}
          onToggle={() => toggleSection("backup")}
        />
        {expanded.has("backup") && (
          <BackupSection
            status={status}
            onSaved={onSaved}
            saveField={saveField}
            lastSavedField={lastSavedField}
          />
        )}

        {/* ══ 请求限流 ══ */}
        <SumRow
          icon="sliders"
          label="请求限流"
          value={`每 ${windowSec} 秒最多 ${status?.rateLimit.maxRequests ?? 100} 次，超出拒绝`}
          expanded={expanded.has("rate")}
          onToggle={() => toggleSection("rate")}
        />
        {expanded.has("rate") && (
          <RateLimitSection status={status} saveField={saveField} lastSavedField={lastSavedField} />
        )}

        {/* ══ 后台命令 ══ */}
        <SumRow
          icon="terminal"
          label="后台命令"
          value={`结束后保留 ${status?.commandCleanupSecs ?? 120} 秒供查看输出`}
          expanded={expanded.has("cleanup")}
          onToggle={() => toggleSection("cleanup")}
        />
        {expanded.has("cleanup") && (
          <CleanupSection status={status} saveField={saveField} lastSavedField={lastSavedField} />
        )}
      </CardContent>
    </Card>
  );
}
