import { useState, useEffect, useRef } from "react";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus } from "../../../lib/types";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Icon } from "../../ui/icon";
import { ToggleRow } from "../../ui/ToggleRow";
import { useToast } from "../../ui/toast";
import { SettingsRow } from "../../ui/SettingsRow";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useSettingSave } from "./useSettingSave";
import { SubSetting } from "./SubSetting";

const DEFAULT_DAYS = 30;

/**
 * 「备份与审计」卡末尾的「变更日志」块：开关 + 保留天数 + 日志目录。
 *
 * 与审计保留策略的区别（设计稿 2026-11-12 已确认）：最小 1 天、不提供永久保留（长期留存由使用方
 * 自己边读边存）；不提供手动清理。缩短保留期要确认，延长不用。
 *
 * 「日志目录」一行放在 SubSetting 的 fieldset 外：日志关闭后历史文件还在，仍允许打开。
 * 单独成文件：BackupAuditGroup 的 hook 数已到上限（check-component-size）。
 */
export function JournalSettings({ status, onSaved }: { status?: StaticStatus; onSaved: () => void }) {
  const { savedKey, save, isPending, errorFor } = useSettingSave(onSaved);
  const { toast } = useToast();
  // 默认关闭：关闭时 AI 看到的工具与说明和加这个功能之前完全一致。
  const on = status?.journalEnabled ?? false;
  const [days, setDays] = useState(String(status?.journalRetentionDays ?? DEFAULT_DAYS));
  const [applied, setApplied] = useState(status?.journalRetentionDays ?? DEFAULT_DAYS);
  const [confirmDays, setConfirmDays] = useState<number | null>(null);
  const synced = useRef(status?.journalRetentionDays);

  // 状态刷新时同步：用户正在改的值（与上次同步值不同）不覆盖，写法同审计保留天数。
  useEffect(() => {
    if (status?.journalRetentionDays === undefined) return;
    const next = status.journalRetentionDays;
    const prev = synced.current;
    setDays(cur => (prev === undefined || cur === String(prev) ? String(next) : cur));
    setApplied(next);
    synced.current = next;
  }, [status?.journalRetentionDays]);

  const valid = days.trim() !== "" && Number.isSafeInteger(Number(days)) && Number(days) >= 1;
  const dirty = valid && Number(days) !== applied;
  const shortening = dirty && Number(days) < applied;

  const apply = async (next: number) => {
    if (await save({ journalRetentionDays: next }, "journal-days")) {
      setApplied(next);
      setDays(String(next));
    }
  };

  // MCP 客户端只在连接时取工具清单与服务说明，切换后必须提示重连，否则用户以为没生效。
  const toggle = async (v: boolean) => {
    if (await save({ journalEnabled: v }, "journal")) {
      toast(`变更日志已${v ? "开启" : "关闭"}。已连接的 AI 客户端需重新连接（Claude Code 里用 /mcp 重连）才生效`, "success");
    }
  };

  const openDir = async () => {
    try {
      await invoke("reveal_journal_dir");
    } catch (e) {
      toast(`打开变更日志目录失败：${e}`, "error");
    }
  };

  return (
    <div className="border-t">
      <ToggleRow
        id="toggle-journal"
        label="变更日志（按需求审查）"
        sub="开启后 AI 写文件可附带需求名与原因，供 NCForge 等程序按需求审查；不含文件内容。切换后 AI 客户端需重新连接"
        checked={on}
        onChange={(v) => void toggle(v)}
        saved={savedKey === "journal"}
        pending={isPending("journal")}
        disabled={isPending("journal") || !status}
        error={errorFor("journal")}
        last
      />
      <SubSetting disabled={!on || !status} hint="变更日志已关闭，保留天数暂不生效">
        <SettingsRow
          id="journal-retention"
          label="保留天数"
          saved={savedKey === "journal-days"}
          pending={isPending("journal-days")}
          error={errorFor("journal-days")}
          layout="stack"
          last
          control={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="number"
                min={1}
                value={days}
                aria-label="变更日志保留天数"
                aria-invalid={!valid}
                disabled={isPending("journal-days")}
                onChange={(e) => setDays(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">天</span>
              <Button
                size="sm"
                disabled={!dirty || isPending("journal-days")}
                isLoading={isPending("journal-days")}
                loadingText="应用中…"
                onClick={() => {
                  const next = Number(days);
                  if (shortening) setConfirmDays(next);
                  else void apply(next);
                }}
              >
                应用
              </Button>
            </div>
          }
          sub={`当前生效：${applied} 天。超期的整天日志文件在下次写入时删除。`}
        />
        {shortening && (
          <p className="mb-3 text-xs leading-relaxed text-warning-ink">
            缩短保留期会删掉超期的日志，还没被其他程序读取归档的改动将无法追溯；应用前需确认。
          </p>
        )}
        {!valid && <p className="mb-3 text-xs text-warning-ink">请输入大于或等于 1 的整数。</p>}
      </SubSetting>
      {/* 与 SubSetting 同样的缩进竖线，但不在 fieldset 里：关闭日志后仍可打开目录。 */}
      <div className="ml-1 border-l-2 border-primary/25 pl-3.5">
        <SettingsRow
          id="journal-dir"
          label="日志目录"
          layout="stack"
          last
          control={
            <div className="flex items-center gap-2">
              <div
                className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground"
                title={status?.journalDir}
              >
                {status?.journalDir || "—"}
              </div>
              <Button variant="outline" size="sm" className="shrink-0" disabled={!status} onClick={openDir}>
                <Icon name="folder" size={14} />
                打开目录
              </Button>
            </div>
          }
          sub="格式说明见 docs/开放能力-变更日志.md"
        />
      </div>

      {confirmDays !== null && (
        <ConfirmDialog
          title="缩短变更日志保留期？"
          variant="destructive"
          confirmLabel="确定缩短"
          description={
            <>
              保留期将从 <b>{applied} 天</b> 改为 <b>{confirmDays} 天</b>，早于 {confirmDays} 天的日志文件会在下次写入时删除，
              删除后<b>不可恢复</b>。
            </>
          }
          onCancel={() => setConfirmDays(null)}
          onConfirm={() => {
            const d = confirmDays;
            setConfirmDays(null);
            void apply(d);
          }}
        />
      )}
    </div>
  );
}
