import { useState, useEffect } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult } from "../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Icon } from "../ui/icon";

/**
 * 设置页「功能开关」卡：白名单 / 只读 / 审计 / 备份 / 限流。
 * 关闭白名单为高风险操作，需二次确认。开关即时保存到后端 config。
 *
 * highlightAnchor：由 Header 安全徽章点击带入（{ anchor, nonce }）。
 * 切换到本页后自动滚动到对应 ToggleRow 并脉冲高亮 2 秒，引导用户定位开关。
 */
export function SettingsToggles({
  status,
  onSaved,
  highlightAnchor,
}: {
  status?: StatusResponse;
  onSaved: () => void;
  highlightAnchor?: { anchor: string; nonce: number } | null;
}) {
  const [confirmWhitelistOff, setConfirmWhitelistOff] = useState(false);
  const [confirmShellOn, setConfirmShellOn] = useState(false);
  const [ackShellRisk, setAckShellRisk] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // 由 Header 安全徽章点击触发的定位 + 高亮。
  // 非激活 Tab 在 Tabs 中为 return null（完全卸载），切到设置页时本组件才挂载，
  // 此时 highlightAnchor 已就绪，挂载即定位，无需额外延时。
  useEffect(() => {
    if (!highlightAnchor?.anchor) return;
    const el = document.getElementById(`toggle-${highlightAnchor.anchor}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("anchor-highlight");
    const t = setTimeout(() => el.classList.remove("anchor-highlight"), 2000);
    return () => clearTimeout(t);
  }, [highlightAnchor]);

  const save = async (patch: Record<string, unknown>) => {
    await invoke<ConfigSaveResult>("save_config", { patch });
    onSaved();
  };

  const handleResetDefaults = async () => {
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
  };

  const handleWhitelist = (next: boolean) => {
    // 打开直接保存；关闭需二次确认（放开对整机文件的保护）。
    if (next) {
      save({ whitelistEnabled: true });
    } else {
      setConfirmWhitelistOff(true);
    }
  };

  const handleShell = (next: boolean) => {
    // 开启命令执行等同于授予 RCE，需二次确认；关闭无需确认。
    if (next) {
      setConfirmShellOn(true);
    } else {
      save({ shellEnabled: false });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="sliders" />}>功能开关</CardTitle>
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
          variant="danger"
          onChange={handleWhitelist}
        />
        <ToggleRow
          id="toggle-readonly"
          label="只读模式"
          sub="开启后禁止写入 / 删除 / 移动 / 复制，仅允许读取、列目录、搜索"
          checked={status?.readonlyMode ?? false}
          onChange={(v) => save({ readonlyMode: v })}
        />
        <ToggleRow
          label="审计日志"
          sub="记录每次工具调用到日志页；关闭后停止记录"
          checked={status?.auditEnabled ?? true}
          onChange={(v) => save({ auditEnabled: v })}
        />
        <ToggleRow
          label="写操作自动备份"
          sub="写入 / 删除前先备份到备份目录；关闭可节省磁盘"
          checked={status?.backupEnabled ?? true}
          onChange={(v) => save({ backupEnabled: v })}
        />
        <ToggleRow
          label="限流保护"
          sub="按窗口限制请求次数，防止异常高频调用"
          checked={status?.rateLimitEnabled ?? true}
          onChange={(v) => save({ rateLimitEnabled: v })}
        />
        <ToggleRow
          label="读取编码自适应"
          sub="读文件时自动识别 GBK/GB18030（如 NC65 源码）；关闭则按 UTF-8 读，避免误判。显式指定编码不受影响"
          checked={status?.encodingDetectEnabled ?? false}
          onChange={(v) => save({ encodingDetectEnabled: v })}
        />
        <ToggleRow
          id="toggle-shell"
          label="命令执行"
          danger={status?.shellEnabled ?? false}
          sub={
            status?.shellEnabled
              ? "⚠ 已开启 · 等同于授予远程任意代码执行权限（RCE），只读模式下强制禁止"
              : "允许远程执行 Shell 命令（run_command）。默认关闭，强烈建议仅临时开启"
          }
          checked={status?.shellEnabled ?? false}
          variant="danger"
          onChange={handleShell}
          last
        />
      </CardContent>

      {confirmWhitelistOff && (
        <ConfirmModal
          onCancel={() => setConfirmWhitelistOff(false)}
          onConfirm={() => {
            save({ whitelistEnabled: false });
            setConfirmWhitelistOff(false);
          }}
        />
      )}
      {confirmShellOn && (
        <ShellRiskModal
          ackRisk={ackShellRisk}
          onAckChange={setAckShellRisk}
          onCancel={() => {
            setConfirmShellOn(false);
            setAckShellRisk(false);
          }}
          onConfirm={() => {
            save({ shellEnabled: true });
            setConfirmShellOn(false);
            setAckShellRisk(false);
          }}
        />
      )}
      {confirmReset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setConfirmReset(false)}
        >
          <div
            className="animate-scale-in mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="mb-2 flex items-center gap-2 text-base font-semibold">
              <Icon name="alertTriangle" size={18} className="text-warning" />
              恢复默认功能开关？
            </h4>
            <p className="mb-4 text-sm text-muted-foreground">
              这将把白名单校验、审计日志、备份、限流重新开启，只读模式、编码自适应、命令执行关闭。
              当前的白名单目录、扩展名等其他设置不会受影响。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmReset(false)}>
                取消
              </Button>
              <Button variant="default" size="sm" onClick={handleResetDefaults}>
                恢复默认
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 恢复默认按钮 */}
      <div className="border-t px-5 py-3">
        <Button variant="outline" size="sm" className="text-muted-foreground" onClick={() => setConfirmReset(true)}>
          <Icon name="refresh" size={13} />
          恢复默认设置
        </Button>
      </div>
    </Card>
  );
}

function ToggleRow({
  label,
  sub,
  checked,
  onChange,
  variant = "default",
  danger = false,
  last = false,
  id,
}: {
  label: string;
  sub: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  variant?: "default" | "danger";
  danger?: boolean;
  last?: boolean;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`flex items-center justify-between gap-4 py-3.5 ${
        last ? "" : "border-b"
      } ${danger ? "-mx-3 rounded-lg bg-destructive/5 px-3" : ""}`}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className={`mt-0.5 text-xs ${danger ? "text-destructive" : "text-muted-foreground"}`}>
          {sub}
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} variant={variant} />
    </div>
  );
}

function ShellRiskModal({
  ackRisk,
  onAckChange,
  onCancel,
  onConfirm,
}: {
  ackRisk: boolean;
  onAckChange: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="animate-scale-in mx-4 w-full max-w-md rounded-xl border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
          <Icon name="alertTriangle" size={18} />
          确定开启命令执行？
        </h4>
        <p className="mb-3 text-sm text-muted-foreground">
          开启后远程 Claude Code 可在白名单目录内执行<b>任意 Shell 命令</b>，包括但不限于安装软件、
          修改系统设置、访问网络。这等同于授予<b>远程任意代码执行权限（RCE）</b>。
        </p>
        <ul className="mb-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>路径白名单 / 扩展名限制等约束可被命令绕过</li>
          <li>Bearer token 鉴权 + 限流是唯一准入防线</li>
          <li>每条命令都会被强制记入审计日志</li>
        </ul>
        <label className="mb-4 flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={ackRisk}
            onChange={(e) => onAckChange(e.target.checked)}
          />
          我已知晓风险，仅在完全可信的网络环境中开启
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" size="sm" disabled={!ackRisk} onClick={onConfirm}>
            确定开启
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="animate-scale-in mx-4 w-full max-w-md rounded-xl border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
          <Icon name="alertTriangle" size={18} />
          确定关闭路径白名单？
        </h4>
        <p className="mb-4 text-sm text-muted-foreground">
          关闭后远程 Claude Code 可读写本机<b>全部文件</b>，风险显著上升。
          请确认你正处于完全可信的网络环境，用完及时开回。
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            确定关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
