import { useState, useEffect, useRef } from "react";
import { SavedHint } from "./SavedHint";

/** 行内数字输入（带防抖自动保存 + 已保存反馈），供设置页各类数值项复用。 */
export function InlineNum({
  value: initial,
  saved,
  unit,
  onSave,
  ariaLabel,
}: {
  value: number;
  saved: boolean;
  unit: string;
  onSave: (v: number) => Promise<void>;
  /** 读屏标签：不带的话读屏只报「数字输入框」，用户不知道在改什么。 */
  ariaLabel?: string;
}) {
  const [value, setValue] = useState(initial);
  const initialized = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!initialized.current) {
      setValue(initial);
      initialized.current = initial !== 0;
    }
  }, [initial]);
  const handleChange = (v: number) => {
    setValue(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSave(v), 800);
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        className="s-input"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => handleChange(Number(e.target.value))}
        onBlur={() => {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            onSave(value);
          }
        }}
      />
      <span className="s-unit">{unit}</span>
      {saved && <SavedHint iconOnly />}
    </div>
  );
}
