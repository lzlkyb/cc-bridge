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
import { NumBox } from "../../ui/NumBox";
import { useSettingSave } from "./useSettingSave";
import { SubSetting } from "./SubSetting";

// 与备份侧的预设对齐（BackupCleanupDialog 的 DAY_PRESETS）：两边文案与心智刻意保持一致。
const BEFORE_PRESETS = [7, 30, 90];

/** 正在跑的「清理早于…」来源。存来源而不是天数：否则自定义值恰好等于某预设时两个按钮会一起转圈。 */
type BeforeBusy = { src: "preset" | "custom"; days: number } | null;

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
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const { savedKey, save } = useSettingSave(onSaved);
  const [days, setDays] = useState(30);
  const [cleaning, setCleaning] = useState(false);
  const [beforeDays, setBeforeDays] = useState(180);
  const [busyBefore, setBusyBefore] = useState<BeforeBusy>(null);
  const { toast } = useToast();
  const initialized = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const auditOn = status?.auditEnabled ?? true;

  useEffect(() => {
    if (status && !initialized.current) {
      setDays(status.auditRetentionDays);
      initialized.current = true;
    }
  }, [status]);

  // 卸载时清悬挂的保存 timer：不清的话改完天数立即切页签，800ms 后仍会发 save_config。
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  // 归一化：空输入 / NaN / 负值统一为 0（配合 Input min=0），并取整。
  const normalize = (raw: number) => (Number.isNaN(raw) || raw < 0 ? 0 : Math.floor(raw));

  const handleDaysChange = (raw: number) => {
    const val = normalize(raw);
    setDays(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // 触发后清空 ref，供 onBlur 判断是否已保存，避免双次保存。
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      save({ auditRetentionDays: val }, "audit-days");
    }, 800);
  };

  // onBlur 仅在 debounce 仍挂起（尚未保存）时立即保存，已保存则不重复。
  const handleDaysBlur = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
      save({ auditRetentionDays: days }, "audit-days");
    }
  };

  /** 按当前保留天数立即清理一次，并把删了多少条告知用户（不再静默）。 */
  const handleCleanNow = async () => {
    // 保留天数 0 = 永久保留，后端会直接返回 0。不特处理的话用户只会看到
    // 「已清理 0 条」而不知道为什么，以为功能坏了。
    if (days === 0) {
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

  return (
    <Card>
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
        />
        {/* 备份的份数/目录/清理在安全页（本次不跨 tab 搬），至少把路指清楚 */}
        <p className="mb-3 rounded-lg bg-primary/8 px-3 py-2 text-[11px] text-primary">
          → 份数 / 目录 / 版本历史 / 清理在「安全页 › 文件管控」
        </p>

        <ToggleRow
          id="toggle-audit"
          label="审计日志"
          sub="记录每次工具调用到日志页；关闭后停止记录"
          checked={auditOn}
          onChange={(v) => save({ auditEnabled: v }, "audit")}
          saved={savedKey === "audit"}
          last
        />
        <SubSetting disabled={!auditOn} hint="审计日志已关闭，下面两项暂不生效">
          <SettingsRow
            label="保留天数"
            saved={savedKey === "audit-days"}
            layout="stack"
            control={
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  value={days}
                  onChange={(e) => handleDaysChange(Number(e.target.value))}
                  onBlur={handleDaysBlur}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  isLoading={cleaning}
                  loadingText="清理中..."
                  onClick={handleCleanNow}
                >
                  立即清理
                </Button>
              </div>
            }
            sub="超过保留天数的审计记录会在启动时、以及之后每 24 小时自动清理；改完保留天数也会立即清理一次。设为 0 表示永久保留。想删得彻底一点可到日志页「清空全部」。"
          />
          <SettingsRow
            label="清理早于…"
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
                    onClick={() => handleCleanBefore(d, "preset")}
                  >
                    {d} 天前
                  </Button>
                ))}
                <NumBox value={beforeDays} min={1} unit="天" onCommit={setBeforeDays} />
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  isLoading={busyBefore?.src === "custom"}
                  loadingText="清理中..."
                  disabled={busyBefore !== null}
                  onClick={() => handleCleanBefore(beforeDays, "custom")}
                >
                  清理自定义天数
                </Button>
              </div>
            }
            sub="按临时天数清一次，不会修改上面的保留天数设置。不同于备份：审计是流式记录，不需要「保留最近 1 份」这种底线。"
          />
        </SubSetting>
      </CardContent>
    </Card>
  );
}
