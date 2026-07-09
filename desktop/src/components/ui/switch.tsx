/**
 * 轻量开关组件（无依赖）。用于设置页功能开关。
 * variant="danger" 时打开态用危险色（白名单关闭这类高风险开关）。
 */
export function Switch({
  checked,
  onChange,
  variant = "default",
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  variant?: "default" | "danger";
  disabled?: boolean;
}) {
  const onColor = variant === "danger" ? "bg-destructive" : "bg-primary";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? onColor : "bg-input"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
