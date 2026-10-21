import { Icon } from "../../ui/icon";
import { SettingsRow } from "../../ui/SettingsRow";
import { SettingsChoice } from "../../ui/SettingsChoice";
import { useTerminalFontStack } from "../../../hooks/useTerminalAppearance";
import { BUNDLED_FAMILIES } from "../../../lib/bundledFonts";
import { FONT_SAMPLE, FONT_STACKS, setFontId, type TerminalFontId } from "../../../lib/terminalFontFamily";
import { useTerminalSettingFeedback } from "./useTerminalSettingFeedback";

/** Show each bundled font with its actual stack; no download/install state is needed. */
export function TerminalFontOptions() {
  const fontStack = useTerminalFontStack();
  const feedback = useTerminalSettingFeedback();
  const selected = FONT_STACKS.find(font => font.stack === fontStack)?.id ?? "default";
  return <SettingsRow id="terminal-font" label="终端字体" sub="全部预设开箱即用，含中文回退" layout="stack"
    saved={feedback.isSaved("font")} error={feedback.errorFor("font")}
    info="只影响终端画布与状态栏。切换后自动重算行列，不重连、不丢历史。全部使用等宽字体及中文回退；样例用于比较易混淆字符。"
    control={<SettingsChoice label="终端字体" value={selected}
      options={FONT_STACKS.map(font => ({ value: font.id, label: <span className="terminal-font-card">
        <span className="terminal-font-sample" style={{ fontFamily: font.stack }}>{FONT_SAMPLE}</span>
        <span className="terminal-font-name">{font.name}{BUNDLED_FAMILIES.some(family => font.stack.startsWith(`"${family}"`)) && <small>内置</small>}</span>
        <span className="terminal-font-description">{font.desc}</span>
        {font.id === selected && <span className="terminal-font-check" aria-hidden="true"><Icon name="check" size={12} /></span>}
      </span> }))}
      onChange={id => feedback.apply("font", () => setFontId(id as TerminalFontId))} />} />;
}
