import { Switch } from "./switch";
import { SavedHint } from "./SavedHint";

/**
 * 设置页通用的「开关行」：左侧标签 + 描述，右侧 Switch。
 * 共享组件，供 `tabs/settings/` 下的各张设置卡与安全页复用。
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
      className={`srow flex items-center justify-between gap-4 py-3.5 ${
        last ? "" : "border-b"
      } ${danger ? "-mx-3 rounded-lg bg-destructive/5 px-3" : ""}`}
    >
      <div className="grow min-w-0">
        <div className="flex items-center gap-2">
          <span className="t text-sm font-medium">{label}</span>
          {saved && <SavedHint>已保存</SavedHint>}
        </div>
        <div className={`d mt-0.5 text-xs ${danger ? "text-destructive" : "text-muted-foreground"}`}>
          {sub}
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} variant={variant} ariaLabel={label} />
    </div>
  );
}
