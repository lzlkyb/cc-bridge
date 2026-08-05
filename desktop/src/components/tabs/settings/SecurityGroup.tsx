import { useState } from "react";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus, ConfigSaveResult } from "../../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { ToggleRow } from "../../ui/ToggleRow";
import { useToast } from "../../ui/toast";
import { shellTypeCopy } from "../../../lib/platform";
import { useSettingSave } from "./useSettingSave";
import { SubSetting } from "./SubSetting";
import { ShellTypeRow } from "./ShellTypeRow";
import { WhitelistOffModal, ShellRiskModal, ResetModal } from "./modals";

/**
 * 「安全」卡：白名单校验 / 只读模式 / 命令执行（+ 壳层子项）。
 *
 * 从原「功能开关」那张 698 行的大卡拆出来。那张卡已经有 `GroupTitle` 分组，
 * 但分组只是小标题、**没有视觉边界**，13 个控件连着滚，滚到中间就不知道
 * 自己在哪一节。拆卡不是新增分组，是把已有分组做成形。
 *
 * 壳层选择从「兼容与性能」搬到这里作为命令执行的**子项**：它就是命令执行的参数，
 * 而之前隔了 3 个开关、命令执行关闭后它依旧可改。
 *
 * 不动 `toggle-*` 的 DOM id：Header 安全徽章与命令面板靠它们跳转。
 */
export function SecurityGroup({
  status,
  onSaved,
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const { savedKey, save } = useSettingSave(onSaved);
  const [confirmWhitelistOff, setConfirmWhitelistOff] = useState(false);
  const [confirmShellOn, setConfirmShellOn] = useState(false);
  const [ackShellRisk, setAckShellRisk] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [refreshingBash, setRefreshingBash] = useState(false);
  // 壳层相关的平台文案（toast 与 ShellTypeRow 共用同一份，避免两处各写一句逐渐跑偏）
  const shellCopy = shellTypeCopy(status?.platform);
  const { toast } = useToast();

  const readonly = status?.readonlyMode ?? false;
  const shellOn = status?.shellEnabled ?? false;

  const handleWhitelist = (next: boolean) => {
    // 打开直接保存；关闭需二次确认（放开对整机文件的保护）。
    if (next) {
      save({ whitelistEnabled: true }, "whitelist");
    } else {
      setConfirmWhitelistOff(true);
    }
  };

  const handleShell = (next: boolean) => {
    // 开启命令执行等同于授予 RCE，需二次确认；关闭无需确认。
    if (next) {
      setConfirmShellOn(true);
    } else {
      save({ shellEnabled: false }, "shell");
    }
  };

  const handleResetDefaults = async () => {
    try {
      await invoke<ConfigSaveResult>("save_config", {
        patch: {
          whitelistEnabled: true,
          readonlyMode: false,
          auditEnabled: true,
          backupEnabled: true,
          rateLimitEnabled: true,
          encodingDetectEnabled: false,
          shellEnabled: false,
        },
      });
      setConfirmReset(false);
      onSaved();
    } catch (e) {
      toast(`恢复默认失败：${e}`, "error");
    }
  };

  return (
    <Card id="set-security">
      <CardHeader>
        <CardTitle icon={<Icon name="shield" />}>安全</CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        <ToggleRow
          id="toggle-whitelist"
          label="路径白名单校验"
          danger={status ? !status.whitelistEnabled : false}
          sub={
            status && !status.whitelistEnabled
              ? "⚠ 已关闭 · 远程可访问本机全部文件，仅剩 Token 保护"
              : "仅允许访问白名单根目录内的文件（强烈建议保持开启）"
          }
          checked={status?.whitelistEnabled ?? true}
          onChange={handleWhitelist}
          saved={savedKey === "whitelist"}
        />
        {/* 开关在设置页、目录在安全页（本次不跨 tab 搬），至少把路指清楚 */}
        <p className="mb-3 rounded-lg bg-primary/8 px-3 py-2 text-[11px] text-primary">
          → 白名单目录与配置组在「安全页 › 白名单根目录」
        </p>
        <ToggleRow
          id="toggle-readonly"
          label="只读模式"
          sub="开启后禁止写入 / 删除 / 移动 / 复制，仅允许读取、列目录、搜索"
          checked={readonly}
          onChange={(v) => save({ readonlyMode: v }, "readonly")}
          saved={savedKey === "readonly"}
        />
        <ToggleRow
          id="toggle-shell"
          label="命令执行"
          danger={shellOn}
          sub={
            readonly
              ? "当前只读模式已开启，命令执行将被强制禁止；如需启用请先关闭只读模式"
              : shellOn
                ? "⚠ 已开启 · 等同于授予远程任意代码执行权限（RCE）"
                : "允许远程执行 Shell 命令（run_command）。默认关闭，强烈建议仅临时开启"
          }
          checked={shellOn}
          variant="danger"
          onChange={handleShell}
          saved={savedKey === "shell"}
          last
        />
        {/* 壳层是命令执行的参数，命令执行关着时调它不产生任何效果 */}
        <SubSetting disabled={!shellOn} hint="命令执行已关闭，壳层设置暂不生效">
          <ShellTypeRow
            platform={status?.platform}
            value={status?.shellType ?? "cmd"}
            bashAvailable={status?.bashAvailable ?? true}
            onSelect={(v) => save({ shellType: v }, "shelltype")}
            onBashUnavailable={() => toast(shellCopy.unavailableToast, "warning")}
            onRefreshBash={async () => {
              setRefreshingBash(true);
              try {
                const found = await invoke<boolean>("refresh_bash_detection");
                if (found) {
                  toast("已检测到 bash，现在可以切换了", "success");
                } else {
                  toast(shellCopy.stillUnavailableToast, "warning");
                }
              } catch {
                toast("检测失败，请稍后重试", "error");
              } finally {
                setRefreshingBash(false);
                onSaved(); // 触发 get_status 刷新 bashAvailable
              }
            }}
            refreshingBash={refreshingBash}
            saved={savedKey === "shelltype"}
            last
          />
        </SubSetting>
      </CardContent>

      {confirmWhitelistOff && (
        <WhitelistOffModal
          onCancel={() => setConfirmWhitelistOff(false)}
          onConfirm={() => {
            save({ whitelistEnabled: false }, "whitelist");
            setConfirmWhitelistOff(false);
          }}
        />
      )}
      {confirmShellOn && (
        <ShellRiskModal
          readonly={readonly}
          ackRisk={ackShellRisk}
          onAckChange={setAckShellRisk}
          onCancel={() => {
            setConfirmShellOn(false);
            setAckShellRisk(false);
          }}
          onConfirm={() => {
            save({ shellEnabled: true }, "shell");
            setConfirmShellOn(false);
            setAckShellRisk(false);
          }}
        />
      )}
      {confirmReset && (
        <ResetModal onCancel={() => setConfirmReset(false)} onConfirm={handleResetDefaults} />
      )}

      {/* 重置覆盖的是安全 + 数据保护 + 高级三张卡的开关（与原行为一致，未改范围），
          放在风险最高的这张卡底部；文案说清范围，不让用户以为只重置安全项。 */}
      <div className="border-t px-5 py-3">
        <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)}>
          <Icon name="refresh" size={13} />
          重置全部功能开关为默认
        </Button>
      </div>
    </Card>
  );
}
