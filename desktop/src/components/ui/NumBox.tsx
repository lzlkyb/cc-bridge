import { useEffect, useState } from "react";
import { Input } from "./input";

/**
 * 小号数字输入框（带单位）。
 *
 * 为何不直接用受控的 `<Input type="number" value={n}>`：那种写法配上
 * `Math.max(min, Number(v) || min)` 归一化后，用户退格删到空会被立即回填成 min，
 * 根本无法「先清空再输两位数」。这里内部存字符串、允许中间态为空，
 * 只在值合法时向上 commit，失焦时把非法输入回退到最后一个合法值。
 */
export function NumBox({
  value,
  min,
  unit,
  onCommit,
  className = "w-24",
}: {
  value: number;
  min: number;
  unit?: string;
  /** 仅在输入合法（整数且 >= min）时触发 */
  onCommit: (n: number) => void;
  className?: string;
}) {
  const [text, setText] = useState(String(value));

  // 外部改值（比如点了预设芯片）时跟随
  useEffect(() => {
    setText(String(value));
  }, [value]);

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <Input
        type="number"
        min={min}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const n = Number(raw);
          if (raw.trim() !== "" && Number.isFinite(n) && Number.isInteger(n) && n >= min) {
            onCommit(n);
          }
        }}
        onBlur={() => setText(String(value))}
      />
      {unit && <span className="shrink-0 text-[11px] text-muted-foreground">{unit}</span>}
    </div>
  );
}
