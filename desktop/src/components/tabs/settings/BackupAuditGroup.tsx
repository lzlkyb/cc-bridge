import { useState, useEffect, useRef } from "react";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus } from "../../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Icon } from "../../ui/icon";
import { ToggleRow } from "../../ui/ToggleRow";
import { useToast } from "../../ui/toast";
import { SettingsRow } from "../../ui/SettingsRow";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useSettingSave } from "./useSettingSave";
import { SubSetting } from "./SubSetting";

// 与备份侧的预设对齐（BackupCleanupDialog 的 DAY_PRESETS）：两边文案与心智刻意保持一致。
const BEFORE_PRESETS = [7, 30, 90];

/** 正在跑的「清理早于…」来源。存来源而不是天数：否则自定义值恰好等于某预设时两个按钮会一起转圈。 */
type BeforeBusy = { src: "preset" | "custom"; days: number } | null;

/** 待确认的清理动作（P1-3：五个清理入口全部过确认，不再点击即永久删除）。 */
type PendingClean =
  | { src: "now" }
  | { src: "policy"; days: number }
  | { src: "before"; days: number; origin: "preset" | "custom" };

/**
 * 「备份与审计」卡：两个开关 + 审计的两个参数。
 *
 * 合并了原来的 `AuditGroup`：之前「审计日志」开关在第 4 张卡、保留天数在第 8 张卡，
 * 隔了四张卡——关了开关参数还能改，也看不出两者有关。现在参数作为开关的
 * 子项紧跟在下，开关关闭时整块置灰。
 *
 * 与备份侧的区别：审计**不需要**「保留最近 1 份」那种底线——它是流式记录，
 * 删旧条不会让某个东西“没有历史”；而删备份可能让某个文件彻底没了可还原版本。
 */
export function BackupAuditGroup({
  status,
  onSaved,
  onNavigate,
}: {
  status?: StaticStatus;
  onSaved: () => void;
  /** 跨 tab 跳转（备份指路按钮用；不传则回退为静态指路文案）。 */
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const { savedKey, save, isPending, errorFor } = useSettingSave(onSaved);
  const [days, setDays] = useState(String(status?.auditRetentionDays ?? 30));
  const [appliedDays, setAppliedDays] = useState(status?.auditRetentionDays ?? 30);
  const [cleaning, setCleaning] = useState(false);
  const [beforeDays, setBeforeDays] = useState("180");
  const [busyBefore, setBusyBefore] = useState<BeforeBusy>(null);
  const [pendingClean, setPendingClean] = useState<PendingClean | null>(null);
  const { toast } = useToast();
  const syncedDays = useRef(status?.auditRetentionDays);

  const auditOn = status?.auditEnabled ?? true;

  useEffect(() => {
    if (status?.auditRetentionDays === undefined) return;
    const next = status.auditRetentionDays;
    const previous = syncedDays.current;
    setDays(cur => previous === undefined || cur === String(previous) ? String(next) : cur);
    setAppliedDays(next);
    syncedDays.current = next;
  }, [status?.auditRetentionDays]);
  const validDays = days.trim() !== "" && Number.isSafeInteger(Number(days)) && Number(days) >= 0;
  const dirtyDays = validDays && Number(days) !== appliedDays;
  const applyPolicy = async (next: number) => {
    if (await save({ auditRetentionDays: next }, "audit-days")) {
      setAppliedDays(next);
      setDays(String(next));
    }
  };

  /** 按当前保留天数立即清理一次，并把删了多少条告知用户（不再静默）。 */
  const handleCleanNow = async () => {
    // 保留天数 0 = 永久保留，后端会直接返回 0。不特处理的话用户只会看到
    // 「已清理 0 条」而不知道为什么，以为功能坏了。
    if (appliedDays === 0) {
      toast("当前设为永久保留（保留天数 0），未清理。可用下方「清理早于…」按临时天数清", "error");
      return;
    }
    setCleaning(true);
    try {
      const removed = await invoke<number>("cleanup_audit_now");
      toast(removed > 0 ? `已清理 ${removed} 条过期记录` : "没有超过保留天数的记录", "success");
      onSaved();
    } catch (e) {
      toast(`清理失败：${e}`, "error");
    } finally {
      setCleaning(false);
    }
  };

  /** 按**临时**天数清一次，不改上面的保留天数配置。 */
  const handleCleanBefore = async (d: number, src: "preset" | "custom") => {
    setBusyBefore({ src, days: d });
    try {
      const removed = await invoke<number>("cleanup_audit_before", { days: d });
      toast(
        removed > 0 ? `已删除早于 ${d} 天的 ${removed} 条记录` : `没有早于 ${d} 天的记录`,
        "success",
      );
      onSaved();
    } catch (e) {
      toast(`清理失败：${e}`, "error");
    } finally {
      setBusyBefore(null);
    }
  };

  // id 供设置页左栏导航 scrollspy 定位（lib/settingsSections.ts）。
  return (
    <Card id="set-backupaudit">
      <CardHeader>
        <CardTitle icon={<Icon name="history" />}>备份与审计</CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        <ToggleRow
          id="toggle-backup"
          label="写操作自动备份"
          sub="写入 / 删除前先备份到备份目录；关闭可节省磁盘"
          checked={status?.backupEnabled ?? true}
          onChange={(v) => save({ backupEnabled: v }, "backup")}
          saved={savedKey === "backup"}
          pending={isPending("backup")}
          disabled={isPending("backup") || !status}
          error={errorFor("backup")}
        />
        {/* 备份的份数/目录/清理在安全页（本次不跨 tab 搬）。P2-5：指路从静态 <p>
            升级为按钮——走 App 已有 pendingAnchor/highlightAnchor 机制，切 tab +
            滚动 + 黄框高亮一气呵成，不让用户自己去别的 tab 找。onNavigate 缺省
            （理论上不会）回退为静态文案，信息量不丢。 */}
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate("security", "set-backup")}
            className="mb-3 flex w-full items-center gap-2 rounded-lg border border-primary/30 bg-primary/8 px-3 py-2 text-left text-xs font-semibold text-primary transition-colors hover:bg-primary/12"
          >
            <Icon name="external" size={13} className="shrink-0" />
            前往：安全页 › 文件管控
            <span className="font-normal text-muted-foreground">（份数 / 目录 / 版本历史 / 清理）</span>
          </button>
        ) : (
          <p className="mb-3 rounded-lg bg-primary/8 px-3 py-2 text-xs text-primary">
            → 份数 / 目录 / 版本历史 / 清理在「安全页 › 文件管控」
          </p>
        )}

        <ToggleRow
          id="toggle-audit"
          label="审计日志"
          sub="记录每次工具调用到日志页；关闭后停止记录"
          checked={auditOn}
          onChange={(v) => save({ auditEnabled: v }, "audit")}
          saved={savedKey === "audit"}
          pending={isPending("audit")}
          disabled={isPending("audit") || !status}
          error={errorFor("audit")}
          last
        />
        <SubSetting disabled={!auditOn || !status} hint="审计日志已关闭或尚未读取，下面两项暂不生效">
          <SettingsRow
            id="audit-retention"
            label="自动保留策略"
            saved={savedKey === "audit-days"}
            pending={isPending("audit-days")}
            error={errorFor("audit-days")}
            layout="stack"
            control={
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  value={days}
                  aria-label="审计保留天数"
                  aria-describedby="audit-retention-help"
                  aria-invalid={!validDays}
                  disabled={isPending("audit-days")}
                  onChange={(e) => setDays(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">天</span>
                <Button variant="outline" size="sm" disabled={isPending("audit-days")} onClick={() => setDays("0")}>永久保留</Button>
                <Button size="sm" disabled={!dirtyDays || isPending("audit-days")} isLoading={isPending("audit-days")} loadingText="应用中…" onClick={() => {
                  const next = Number(days);
                  // 后端收到保留期就会清理；缩短策略必须先明确确认，不能在输入/失焦触发。
                  if (next !== 0 && (appliedDays === 0 || next < appliedDays)) setPendingClean({ src: "policy", days: next });
                  else void applyPolicy(next);
                }}>应用保留策略</Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  isLoading={cleaning}
                  loadingText="清理中..."
                  onClick={() => {
                    // 保留天数 0 = 永久保留：点了必是「已清理 0 条」，先拦下别弹确认框。
                    if (appliedDays === 0) {
                      toast("当前设为永久保留（保留天数 0），未清理。可用下方「清理早于…」按临时天数清", "error");
                      return;
                    }
                    setPendingClean({ src: "now" });
                  }}
                >
                  立即清理
                </Button>
              </div>
            }
            sub={`当前生效：${appliedDays === 0 ? "永久保留" : `${appliedDays} 天`}。修改后点击应用。`}
            info="超过保留天数的记录会在启动时、每 24 小时及应用保留策略后清理；设为 0 表示永久保留。"
          />
          <p id="audit-retention-help" className="mb-3 text-xs leading-relaxed text-warning-ink">缩短保留期会永久删除超期记录，应用前需确认；输入和失焦不会触发清理。{!validDays && " 请输入大于或等于 0 的整数。"}</p>
          <SettingsRow
            id="audit-clean" label="清理早于…"
            layout="stack"
            last
            control={
              <div className="flex flex-wrap items-center gap-2">
                {BEFORE_PRESETS.map((d) => (
                  <Button
                    key={d}
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    isLoading={busyBefore?.src === "preset" && busyBefore.days === d}
                    loadingText="清理中..."
                    disabled={busyBefore !== null}
                    onClick={() => setPendingClean({ src: "before", days: d, origin: "preset" })}
                  >
                    {d} 天前
                  </Button>
                ))}
                <Input type="number" min={1} aria-label="自定义审计清理天数" value={beforeDays} className="w-24" onChange={e => setBeforeDays(e.target.value)} />
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  isLoading={busyBefore?.src === "custom"}
                  loadingText="清理中..."
                  disabled={busyBefore !== null || !Number.isSafeInteger(Number(beforeDays)) || Number(beforeDays) < 1}
                  onClick={() => setPendingClean({ src: "before", days: Number(beforeDays), origin: "custom" })}
                >
                  清理自定义天数
                </Button>
              </div>
            }
            sub="临时清一次，不改保留天数"
            info="按临时天数清一次，不会修改上面的保留天数设置。不同于备份：审计是流式记录，不需要「保留最近 1 份」这种底线。"
          />
        </SubSetting>
      </CardContent>

      {/* P1-3：五个清理入口共用一个确认框（与日志页「清空日志」同标准），描述按
          入口动态生成——「自定义天数」最易误点，必须确认。确认后才真正调
          handleCleanNow / handleCleanBefore，行为不变；先关框再执行，按钮上的
          loading 仍可见（框是 portal 的，关闭后 spinner 在原按钮上转）。 */}
      {pendingClean && (
        <ConfirmDialog
          title={pendingClean.src === "policy" ? "应用保留策略并清理？" : "删除审计记录？"}
          variant="destructive"
          confirmLabel={pendingClean.src === "policy" ? "应用并清理" : "确定删除"}
          description={
            pendingClean.src === "now" ? (
              <>
                「立即清理」将删除<b>超过当前保留天数（{appliedDays} 天）</b>的全部审计记录，删除后
                <b>不可恢复</b>。
              </>
            ) : pendingClean.src === "policy" ? (
              <>保留策略将改为 <b>{pendingClean.days} 天</b>，并立即删除早于 {pendingClean.days} 天的审计记录。删除后<b>不可恢复</b>。</>
            ) : (
              <>
                将删除<b>早于 {pendingClean.days} 天</b>的全部审计记录（不会修改保留天数设置），
                删除后<b>不可恢复</b>。
              </>
            )
          }
          onCancel={() => setPendingClean(null)}
          onConfirm={() => {
            const p = pendingClean;
            setPendingClean(null);
            if (p.src === "now") void handleCleanNow();
            else if (p.src === "policy") void applyPolicy(p.days);
            else void handleCleanBefore(p.days, p.origin);
          }}
        >
          <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs leading-relaxed text-warning-ink">
            <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
            <span>删除后无法在日志页追溯历史调用。如想留档，可先到日志页导出 JSON / CSV。</span>
          </div>
        </ConfirmDialog>
      )}
    </Card>
  );
}
