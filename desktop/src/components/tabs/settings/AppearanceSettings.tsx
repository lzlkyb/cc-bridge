import { useAppearance } from "../../../hooks/useAppearance";
import { useThemeMode } from "../../../hooks/useThemeMode";
import { applyAppearance, type Appearance } from "../../../lib/appearance";
import { applyTheme } from "../../../lib/theme";
import { SettingsChoice } from "../../ui/SettingsChoice";
import { Icon } from "../../ui/icon";
import { AppearancePreview } from "./AppearancePreview";
import { SettingsRow } from "../../ui/SettingsRow";
import { useToast } from "../../ui/toast";

export function AppearanceSettings() {
  const appearance = useAppearance();
  const theme = useThemeMode();
  const { toast } = useToast();
  const selectAppearance = (next: Appearance) => {
    if (!applyAppearance(next)) toast("外观已切换，但暂时无法记住选择。", "info");
  };

  return (
    <section aria-labelledby="appearance-title" className="border-b border-border pb-2">
      <h3 id="appearance-title" className="pt-1 text-sm font-semibold">外观</h3>
      <SettingsRow
        id="app-style"
        label="界面风格"
        sub="即时切换，保留当前页面与终端会话"
        layout="stack"
        control={
          <div className="appearance-choice"><SettingsChoice label="界面风格" value={appearance} onChange={next => selectAppearance(next as Appearance)} options={(["classic", "glass"] as const).map(value => ({ value, label: <><AppearancePreview appearance={value} /><span className="appearance-choice-caption"><span><b>{value === "classic" ? "经典" : "柔光玻璃"}</b><small>{value === "classic" ? "清晰简洁，专注内容" : "通透层次，柔和光影"}</small></span>{appearance === value && <span className="appearance-choice-check"><Icon name="check" size={12} /></span>}</span></> }))} /></div>
        }
      />
      <SettingsRow
        id="app-mode"
        label="明暗模式"
        sub="与界面风格、终端配色分别设置"
        last
        control={
          <SettingsChoice label="应用明暗模式" value={theme} options={[{value:"light",label:"浅色"},{value:"dark",label:"深色"}]} onChange={value => { if (!applyTheme(value as "light" | "dark")) toast("明暗已切换，但暂时无法记住选择。", "info"); }} />
        }
      />
    </section>
  );
}
