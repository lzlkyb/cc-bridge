import { useState } from "react";
import type { StaticStatus } from "../../../lib/types";
import { ToggleRow } from "../../ui/ToggleRow";
import { SettingsRow } from "../../ui/SettingsRow";
import { SettingsChoice } from "../../ui/SettingsChoice";
import { InlineNotice } from "../../ui/notice";
import { TUI_SCROLL_SPEEDS, loadTuiScrollSpeed, saveTuiScrollSpeed, type TuiScrollSpeed } from "../../../lib/terminalScrollSpeed";
import { useSettingSave } from "./useSettingSave";
import { useTerminalSettingFeedback } from "./useTerminalSettingFeedback";

const noop = () => {};

export function TerminalInteractionSettings({ status, onSaved = noop }: { status?: StaticStatus; onSaved?: () => void }) {
  const [speed, setSpeed] = useState(loadTuiScrollSpeed);
  const saveState = useSettingSave(onSaved);
  const feedback = useTerminalSettingFeedback();
  return <section className="terminal-settings-section" aria-labelledby="terminal-interaction-title">
    <h2 id="terminal-interaction-title">选择与滚动</h2>
    <ToggleRow id="toggle-ssh-drag-select" label="终端拖拽即选" sub="直接拖选文字，无需按住 Shift"
      info="关闭后仍可使用 Shift 拖选或工具栏的选择模式。远端未开启鼠标追踪时，原生拖选本来就可用。"
      checked={status?.sshDragSelectEnabled ?? true} disabled={!status}
      pending={saveState.isPending("ssh-drag-select")} saved={saveState.isSaved("ssh-drag-select")} error={saveState.errorFor("ssh-drag-select")}
      onChange={value => { void saveState.save({ sshDragSelectEnabled: value }, "ssh-drag-select"); }} />
    <ToggleRow id="toggle-ssh-copy-on-select" label="选中即复制" sub="拖选后松手自动复制；关闭后使用菜单或快捷键"
      info="双击选词、三击选行不触发自动复制。关闭后使用右键菜单、工具栏或 Ctrl+Shift+C 复制。"
      checked={status?.sshCopyOnSelectEnabled ?? true} disabled={!status}
      pending={saveState.isPending("ssh-copy-on-select")} saved={saveState.isSaved("ssh-copy-on-select")} error={saveState.errorFor("ssh-copy-on-select")}
      onChange={value => { void saveState.save({ sshCopyOnSelectEnabled: value }, "ssh-copy-on-select"); }} />
    <SettingsRow id="terminal-scroll-speed" label="TUI 滚动速度" sub="拖动虚拟滚动条时，每个像素对应的内容行数" last
      info="1 行精细跟手；长对话可选择 3 或 5 行。改动即时生效。"
      saved={feedback.isSaved("speed")} error={feedback.errorFor("speed")}
      control={<SettingsChoice label="TUI 滚动速度" value={String(speed)} options={TUI_SCROLL_SPEEDS.map(v => ({ value: String(v), label: `${v} 行` }))}
        onChange={value => { const next = Number(value) as TuiScrollSpeed; setSpeed(next); feedback.apply("speed", () => saveTuiScrollSpeed(next)); }} />} />
    <InlineNotice variant="info" className="mt-3">Claude Code 等全屏程序中，滚动条会自动切换为「TUI 滚动」。如需使用终端原生回滚，可在 Claude Code 中运行 <code>/tui default</code>。</InlineNotice>
  </section>;
}
