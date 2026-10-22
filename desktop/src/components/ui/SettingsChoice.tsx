import type { ReactNode } from "react";
import "../../settings-choice.css";

/** Short exclusive settings share radio semantics and arrow-key navigation. */
export function SettingsChoice({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: string;
  options: { value: string; label: ReactNode }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return <div className="settings-choice" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
    {options.map((option, index) => <button key={option.value} type="button" role="radio"
      aria-checked={value === option.value} disabled={disabled}
      tabIndex={value === option.value || !options.some(o => o.value === value) && index === 0 ? 0 : -1}
      onClick={() => { if (value !== option.value) onChange(option.value); }}
      onKeyDown={event => {
        if (disabled) return;
        const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : step ? (index + step + options.length) % options.length : -1;
        if (next < 0) return;
        event.preventDefault();
        onChange(options[next].value);
        (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
      }}>{option.label}</button>)}
  </div>;
}
