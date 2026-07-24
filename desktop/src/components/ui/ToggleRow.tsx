import { Switch } from "./switch";
import { SavedHint } from "./SavedHint";

/**
 * 设置页通用的「开关行」：左侧标签 + 描述，右侧 Switch。
 * 从 SettingsToggles 内部抽出为共享组件，供各设置类页面复用。
 */
export function ToggleRow({
  label,
  sub,
  checked,
  onChange,
  variant = "default",
  danger = false,
  last = false,
  saved = false,
  id,
}: {
  label: string;
  sub: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  variant?: "default" | "danger";
  danger?: boolean;
  last?: boolean;
  saved?: boolean;
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
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {saved && <SavedHint>已保存</SavedHint>}
        </div>
        <div className={`mt-0.5 text-xs ${danger ? "text-destructive" : "text-muted-foreground"}`}>
          {sub}
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} variant={variant} ariaLabel={label} />
    </div>
  );
}
