import { useState } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult } from "../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Icon } from "../ui/icon";
import { Switch } from "../ui/switch";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * 安全概览卡（方案 A 顶部）。
 * 把「路径白名单 / 命令执行 / 只读模式」三个核心安全开关从设置页搬到安全页，
 * 复用同一 save_config 通道与二次确认弹窗（不削弱安全）。
 * 顶部风险总览沿用设置页 RiskSummary 的判定。
 */
export function SecurityOverview({
  status,
  onSaved,
}: {
  status?: StatusResponse;
  onSaved: () => void;
}) {
  const [confirmWhitelistOff, setConfirmWhitelistOff] = useState(false);
  const [confirmShellOn, setConfirmShellOn] = useState(false);
  const [ackShellRisk, setAckShellRisk] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const save = async (patch: Record<string, unknown>, key?: string) => {
    await invoke<ConfigSaveResult>("save_config", { patch });
    onSaved();
    if (key) {
      setSavedKey(key);
      setTimeout(() => setSavedKey((cur) => (cur === key ? null : cur)), 1500);
    }
  };

  const readonly = status?.readonlyMode ?? false;

  const handleWhitelist = (next: boolean) => {
    if (next) save({ whitelistEnabled: true }, "whitelist");
    else setConfirmWhitelistOff(true);
  };
  const handleShell = (next: boolean) => {
    if (next) setConfirmShellOn(true);
    else save({ shellEnabled: false }, "shell");
  };

  return (
    <Card>
      <CardHeader
        className="flex-row items-center justify-between cursor-pointer select-none"
        onClick={() => setOpen((o) => !o)}
      >
        <CardTitle icon={<Icon name="shield" />}>安全概览</CardTitle>
        <Icon
          name="chevronDown"
          size={16}
          className={`text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <RiskSummary status={status} />
        {open && (
          <>
            <ToggleRow
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
            <ToggleRow
              label="只读模式"
              sub="开启后禁止写入 / 删除 / 移动 / 复制，仅允许读取、列目录、搜索"
              checked={readonly}
              onChange={(v) => save({ readonlyMode: v }, "readonly")}
              saved={savedKey === "readonly"}
            />
            <ToggleRow
              label="命令执行"
              danger={status?.shellEnabled ?? false}
              variant="danger"
              sub={
                readonly
                  ? "当前只读模式已开启，命令执行将被强制禁止；如需启用请先关闭只读模式"
                  : status?.shellEnabled
                    ? "⚠ 已开启 · 等同于授予远程任意代码执行权限（RCE）"
                    : "允许远程执行 Shell 命令（run_command）。默认关闭，强烈建议仅临时开启"
              }
              checked={status?.shellEnabled ?? false}
              onChange={handleShell}
              saved={savedKey === "shell"}
              last
            />
          </>
        )}
      </CardContent>

      {confirmWhitelistOff && (
        <ConfirmDialog
          title="确定关闭路径白名单？"
          description={
            <>
              关闭后远程 Claude Code 可读写本机<b>全部文件</b>，风险显著上升。
              请确认你正处于完全可信的网络环境，用完及时开回。
            </>
          }
          variant="destructive"
          confirmLabel="确定关闭"
          onCancel={() => setConfirmWhitelistOff(false)}
          onConfirm={() => {
            save({ whitelistEnabled: false }, "whitelist");
            setConfirmWhitelistOff(false);
          }}
        />
      )}
      {confirmShellOn && (
        <ConfirmDialog
          title="确定开启命令执行？"
          variant="destructive"
          confirmLabel="确定开启"
          confirmDisabled={!ackShellRisk}
          onCancel={() => {
            setConfirmShellOn(false);
            setAckShellRisk(false);
          }}
          onConfirm={() => {
            save({ shellEnabled: true }, "shell");
            setConfirmShellOn(false);
            setAckShellRisk(false);
          }}
        >
          {readonly && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <Icon name="lock" size={14} className="mt-0.5 shrink-0" />
              <span>
                当前<b>只读模式已开启</b>，命令执行会被<b>强制禁止</b>而不会生效。如需真正启用，请先在上方关闭只读模式。
              </span>
            </div>
          )}
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
              checked={ackShellRisk}
              onChange={(e) => setAckShellRisk(e.target.checked)}
            />
            我已知晓风险，仅在完全可信的网络环境中开启
          </label>
        </ConfirmDialog>
      )}
    </Card>
  );
}

/* 风险总览：三档（较安全 / 有风险 / 高风险），视觉与设计稿一致 */
function RiskSummary({ status }: { status?: StatusResponse }) {
  if (!status) return null;
  const readonlyOn = status.readonlyMode;
  // 只读模式会强制禁用命令执行（后端拦截 run_command），因此风险判定应看“有效”命令执行
  // 状态；否则只要配置 flag 为开，即使实际被只读拦住，也会误报“高风险 RCE”。
  const shellOn = status.shellEnabled && !readonlyOn;
  const whitelistOff = !status.whitelistEnabled;

  let level: string;
  let desc: string;
  let pill: string;

  if (shellOn || whitelistOff) {
    level = "高风险";
    pill = "border-destructive/30 bg-destructive/10 text-destructive";
    if (shellOn && whitelistOff) desc = "命令执行已开启且白名单已关闭，风险极高。";
    else if (shellOn) desc = "命令执行已开启，存在远程代码执行（RCE）风险。";
    else desc = "路径白名单已关闭，远程可读写本机全部文件。";
  } else if (!readonlyOn) {
    level = "有风险";
    pill = "border-warning/30 bg-warning/10 text-warning";
    desc = "白名单校验已开启，但处于可写状态，远程可修改白名单内文件。";
  } else {
    level = "较安全";
    pill = "border-success/30 bg-success/10 text-success";
    desc = "核心高危功能已关闭，远程仅能在白名单内做只读访问。";
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="text-muted-foreground">当前风险等级：</span>
      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-semibold ${pill}`}>
        {level}
      </span>
      <span className="text-muted-foreground">{desc}</span>
    </div>
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
  saved = false,
}: {
  label: string;
  sub: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  variant?: "default" | "danger";
  danger?: boolean;
  last?: boolean;
  saved?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 py-3.5 ${
        last ? "" : "border-b"
      } ${danger ? "-mx-3 rounded-lg bg-destructive/5 px-3" : ""}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {saved && <span className="text-xs font-normal text-success">已保存 ✓</span>}
        </div>
        <div className={`mt-0.5 text-xs ${danger ? "text-destructive" : "text-muted-foreground"}`}>
          {sub}
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} variant={variant} ariaLabel={label} />
    </div>
  );
}

