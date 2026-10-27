import { useRef, useState } from "react";
import { PERMISSION_MODE_LABEL, type CcPermissionMode } from "../../lib/ccGuiTypes";
import { Icon } from "../ui/icon";
import { ChatPopover } from "./ChatPopover";
import { ModelPicker } from "./ModelPicker";

const MODES: { value: CcPermissionMode; description: string }[] = [
  { value: "plan", description: "先分析与制定计划" },
  { value: "default", description: "需要权限时请求你的批准" },
  { value: "acceptEdits", description: "自动允许编辑，其他操作仍按规则确认" },
  { value: "bypassPermissions", description: "跳过操作审批，仅在可信环境使用" },
];

export function RunControls({ model, mode, onModelChange, onModeChange }: {
  model: string;
  mode: CcPermissionMode;
  onModelChange: (model: string) => void;
  onModeChange: (mode: CcPermissionMode) => void;
}) {
  const [open, setOpen] = useState<"model" | "mode" | null>(null);
  const modelAnchor = useRef<HTMLButtonElement>(null);
  const modeAnchor = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={modelAnchor} type="button" className="cc-chat-chip cc-model-chip" data-cc-toggle="model" aria-label="选择模型" aria-expanded={open === "model"} title={model || "跟随默认模型"} onClick={() => setOpen(open === "model" ? null : "model")}>
      <Icon name="sparkles" size={14} /><span>{model || "默认模型"}</span><Icon name="chevronDown" size={11} />
    </button>
    <button ref={modeAnchor} type="button" className="cc-chat-chip" aria-label="执行模式" aria-expanded={open === "mode"} onClick={() => setOpen(open === "mode" ? null : "mode")}>
      <Icon name="shield" size={14} /><span>{PERMISSION_MODE_LABEL[mode]}</span><Icon name="chevronDown" size={11} />
    </button>
    {open === "model" && <ModelPicker value={model} onChange={onModelChange} onClose={() => setOpen(null)} anchorRef={modelAnchor} />}
    {open === "mode" && <ChatPopover anchorRef={modeAnchor} onClose={() => setOpen(null)} label="执行模式" width={316}>
      <div className="cc-chat-section"><strong>执行模式</strong><p className="cc-chat-note">下一轮生效，正在执行的操作保持原设置。</p></div>
      {MODES.map((item) => <button type="button" key={item.value} className={`cc-chat-menu-item ${item.value === "bypassPermissions" ? "cc-mode-danger" : ""}`} aria-pressed={mode === item.value} onClick={() => { onModeChange(item.value); setOpen(null); }}>
        <Icon name={mode === item.value ? "check" : item.value === "bypassPermissions" ? "alertTriangle" : "shield"} size={16} />
        <span>{PERMISSION_MODE_LABEL[item.value]}<small>{item.description}</small></span>
      </button>)}
    </ChatPopover>}
  </>;
}
