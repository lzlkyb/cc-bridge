import { useEffect, useState } from "react";
import type { StaticStatus } from "../../../lib/types";
import { Card, CardContent } from "../../ui/card";
import { SettingsRow } from "../../ui/SettingsRow";
import { SettingsChoice } from "../../ui/SettingsChoice";
import { useTerminalPreset } from "../../../hooks/useTerminalPreset";
import { useTerminalThemeSetting } from "../../../hooks/useTerminalAppearance";
import { PRESETS, setPreset } from "../../../lib/terminalPreset";
import { TERMINAL_MODES, setTerminalMode, type TerminalMode } from "../../../lib/terminalAppearance";
import { type TerminalPreset, terminalThemeOptions } from "../../../lib/terminalTheme";
import { FONT_SIZE_MAX, FONT_SIZE_MIN, clampFontSize, loadFontSize, saveFontSize, subscribeFontSize } from "../../../lib/terminalFontSize";
import { TerminalFontOptions } from "./TerminalFontOptions";
import { TerminalInteractionSettings } from "./TerminalInteractionSettings";
import { TerminalHistorySettings } from "./TerminalHistorySettings";
import { TerminalSettingsPreview } from "./TerminalSettingsPreview";
import { useTerminalSettingFeedback } from "./useTerminalSettingFeedback";
import "./terminal-settings.css";

/** App theme, terminal mode and palette stay independent; changes retain SSH sessions. */
export function TerminalGroup({ status, onSaved }: { status?: StaticStatus; onSaved?: () => void }) {
  const preset = useTerminalPreset();
  const mode = useTerminalThemeSetting();
  const [size, setSize] = useState(loadFontSize);
  const feedback = useTerminalSettingFeedback();
  useEffect(() => subscribeFontSize(setSize), []);
  const changeSize = (next: number) => feedback.apply("size", () => saveFontSize(clampFontSize(next)));

  return <div className="terminal-settings-layout">
    <Card id="set-terminal" className="terminal-settings-reading">
      <CardContent>
        <section className="terminal-settings-section" aria-labelledby="terminal-appearance-title">
          <h2 id="terminal-appearance-title">外观</h2>
          <p className="terminal-settings-intro">应用界面与终端画布分别设置。</p>
          <SettingsRow id="terminal-mode" label="终端明暗" sub="即时切换，不重连、不丢失历史输出"
            saved={feedback.isSaved("mode")} error={feedback.errorFor("mode")}
            control={<SettingsChoice label="终端明暗" value={mode}
              options={TERMINAL_MODES.map(m => ({ value: m.id, label: m.name }))}
              onChange={value => feedback.apply("mode", () => setTerminalMode(value as TerminalMode))} />} />
          <SettingsRow id="terminal-preset" label="终端风格" layout="stack"
            saved={feedback.isSaved("preset")} error={feedback.errorFor("preset")}
            control={<SettingsChoice label="终端风格" value={preset}
              options={PRESETS.map(p => ({ value: p.id, label: <span className="terminal-preset-option">
                <span aria-hidden="true" className="terminal-preset-colors">{["green", "blue", "magenta", "cyan"].map(color =>
                  <i key={color} style={{ background: (terminalThemeOptions("dark", p.id).theme as Record<string, string>)[color] }} />)}</span>
                {p.name}</span> }))}
              onChange={value => feedback.apply("preset", () => setPreset(value as TerminalPreset))} />} />
          <TerminalFontOptions />
          <SettingsRow id="terminal-size" label="终端字号" sub="也可在终端内使用 Ctrl + 滚轮缩放" last
            saved={feedback.isSaved("size")} error={feedback.errorFor("size")}
            control={<div className="terminal-size-stepper">
              <button type="button" aria-label="减小字号" disabled={size <= FONT_SIZE_MIN} onClick={() => changeSize(size - 1)}>−</button>
              <output aria-live="polite">{size}<small>px</small></output>
              <button type="button" aria-label="增大字号" disabled={size >= FONT_SIZE_MAX} onClick={() => changeSize(size + 1)}>+</button>
            </div>} />
        </section>
        <TerminalInteractionSettings status={status} onSaved={onSaved} />
        <TerminalHistorySettings />
      </CardContent>
    </Card>
    <TerminalSettingsPreview />
  </div>;
}
