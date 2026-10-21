import { useAppearance } from "../../../hooks/useAppearance";
import { useThemeMode } from "../../../hooks/useThemeMode";
import { applyAppearance, type Appearance } from "../../../lib/appearance";
import { applyTheme } from "../../../lib/theme";
import { OptionChip } from "../../ui/OptionChip";
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
        label="界面风格"
        sub="即时切换，保留当前页面与终端会话"
        layout="stack"
        control={
          <div role="group" aria-label="界面风格" className="flex flex-wrap gap-1.5">
            <OptionChip on={appearance === "classic"} onClick={() => selectAppearance("classic")}>经典</OptionChip>
            <OptionChip on={appearance === "glass"} onClick={() => selectAppearance("glass")}>柔光玻璃</OptionChip>
          </div>
        }
      />
      <SettingsRow
        label="明暗模式"
        sub="与界面风格、终端配色分别设置"
        layout="stack"
        last
        control={
          <div role="group" aria-label="明暗模式" className="flex flex-wrap gap-1.5">
            <OptionChip on={theme === "light"} onClick={() => applyTheme("light")}>浅色</OptionChip>
            <OptionChip on={theme === "dark"} onClick={() => applyTheme("dark")}>深色</OptionChip>
          </div>
        }
      />
    </section>
  );
}
