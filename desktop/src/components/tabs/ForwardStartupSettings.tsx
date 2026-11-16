import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { FORWARD_AUTO_OPTIONS } from "../../lib/forwardPresentation";
import type { ForwardAuto } from "../../lib/types";

export function ForwardStartupSettings({ value, disabled, saving, onChange }: {
  value: ForwardAuto; disabled: boolean; saving: boolean; onChange: (value: ForwardAuto) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const selected = FORWARD_AUTO_OPTIONS.find(option => option.value === value)!;
  return <footer className="fp-auto-footer">
    <div className="fp-auto-line">
      <div className="fp-auto-summary"><span className="fp-auto-icon"><Icon name="clock" size={21} /></span><div><h2>手动转发启动方式</h2><p>选择开启时机，仅用于本页手动转发。</p></div></div>
      <div className="fp-auto-current" aria-live="polite"><span>{saving ? "正在保存…" : "当前选择"}</span><strong>{selected.label}</strong></div>
      <Button type="button" className="fp-auto-change" variant="outline" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><Icon name="sliders" size={16} />{open ? "收起选项" : "更改启动方式"}<Icon name={open ? "chevronUp" : "chevronDown"} size={15} /></Button>
    </div>
    {open && <fieldset id={id} className="fp-auto-options" disabled={disabled || saving}><legend className="sr-only">选择手动转发启动方式</legend>{FORWARD_AUTO_OPTIONS.map(option => <label key={option.value}><input type="radio" name={id} checked={value === option.value} onChange={() => onChange(option.value)} /><span><strong>{option.label}</strong><small>{option.hint}</small></span></label>)}</fieldset>}
  </footer>;
}
