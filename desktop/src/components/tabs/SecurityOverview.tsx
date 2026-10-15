import { useState } from "react";
import { invoke } from "../../lib/tauri";
import type { StaticStatus, ConfigSaveResult } from "../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Icon } from "../ui/icon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { InlineNotice } from "../ui/notice";
import { ToggleRow } from "../ui/ToggleRow";
import { RiskBand } from "../ui/RiskBand";
import { Collapse } from "../ui/Collapse";

/**
 * 安全概览卡（方案 A 顶部）。
 * 把「路径白名单 / 命令执行 / 只读模式」三个核心安全开关从设置页搬到安全页，
 * 复用同一 save_config 通道与二次确认弹窗（不削弱安全）。
 * 顶部风险总览消费 lib/riskLevel.ts（与设置页 RiskBand 同一判定源）。
 *
 * 2026-10-13（去重统一）：删本地 ToggleRow / RiskSummary 两份私有副本，改 import
 * ui/ 原语；折叠头由 div+onClick 改真 <button aria-expanded>（键盘可达）；
 * 展开态默认开并按 lib/terminalPreset.ts 先例记忆到 localStorage。
 */

/** 概览展开态持久化 key。默认展开：常驻用户不再每次多点一下；收起选择被记住。 */
const OVERVIEW_OPEN_KEY = "cc-bridge.security-overview-open";

function loadOverviewOpen(): boolean {
  try {
    const v = localStorage.getItem(OVERVIEW_OPEN_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true; // 隐私模式：回落默认展开，不抛
  }
}

function saveOverviewOpen(open: boolean): void {
  try {
    localStorage.setItem(OVERVIEW_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* 存不下就算了，不影响功能 */
  }
}

export function SecurityOverview({
  status,
  onSaved,
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const [confirmWhitelistOff, setConfirmWhitelistOff] = useState(false);
  const [confirmShellOn, setConfirmShellOn] = useState(false);
  const [ackShellRisk, setAckShellRisk] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [open, setOpen] = useState(loadOverviewOpen);

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

  const toggleOpen = () =>
    setOpen((o) => {
      saveOverviewOpen(!o);
      return !o;
    });

  return (
    <Card id="sec-overview">
      <CardHeader>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 text-left"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          <CardTitle icon={<Icon name="shield" />} className="flex-1">
            安全概览
          </CardTitle>
          <Icon
            name="chevronDown"
            size={16}
            className={`shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
          />
        </button>
      </CardHeader>
      <CardContent className="space-y-3">
        <RiskBand status={status} />
        <Collapse open={open}>
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
        </Collapse>
      </CardContent>

      {confirmWhitelistOff && (
        <ConfirmDialog
          title="确定关闭路径白名单？"
          description={
            <>
              关闭后远程 AI 工具可读写本机<b>全部文件</b>，风险显著上升。
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
            <InlineNotice variant="warning" icon="lock" className="mb-3">
              当前<b>只读模式已开启</b>，命令执行会被<b>强制禁止</b>而不会生效。如需真正启用，请先在上方关闭只读模式。
            </InlineNotice>
          )}
          <p className="mb-3 text-sm text-muted-foreground">
            开启后远程 AI 工具可在白名单目录内执行<b>任意 Shell 命令</b>，包括但不限于安装软件、
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
