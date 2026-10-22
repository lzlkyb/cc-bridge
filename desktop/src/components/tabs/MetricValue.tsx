import { useAnimatedNumbers } from "../../hooks/useAnimatedNumbers";

/** Keep units and accessible text exact while the visible number settles between samples. */
export function MetricValue({ value, unit, enabled }: { value: string; unit?: string; enabled: boolean }) {
  const number = Number(value.replace(/,/g, ""));
  const valid = value.trim() !== "" && Number.isFinite(number);
  const decimals = value.includes(".") ? value.split(".")[1].length : 0;
  const animated = useAnimatedNumbers([valid ? number : 0], { enabled: enabled && valid, resetKey: `${unit ?? ""}|${valid}` })[0];
  const text = !valid ? value : `${value.startsWith("+") ? "+" : ""}${animated.toLocaleString("en-US", {minimumFractionDigits: decimals, maximumFractionDigits: decimals})}`;
  return <div className="mt-1 text-[24px] font-extrabold leading-none tracking-tight text-foreground" aria-label={`${value}${unit ?? ""}`}>
    <span aria-hidden="true" className="inline-block min-w-[5ch] tabular-nums">{text}</span>
    {unit && <small aria-hidden="true" className="text-xs font-bold text-muted-foreground">{unit}</small>}
  </div>;
}
