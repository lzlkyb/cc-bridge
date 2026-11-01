import { inputPending, inputStatusLabel, type CcInput, type CcInputs } from "../../lib/ccInput";
import { Icon } from "../ui/icon";

/** The latest receipt stays visible; earlier corrections remain inspectable without crowding the draft. */
export function InputReceipts({ inputs, onRecover }: { inputs?: CcInputs; onRecover: (text: string) => void }) {
  const items = Object.values(inputs ?? {});
  if (!items.length) return null;
  const latest = items[items.length - 1];
  const pending = items.filter(input => inputPending(input.status)).length;
  const row = (input: CcInput) => <div key={input.messageId} className="cc-input-receipt" data-state={input.status}>
    <Icon name={inputPending(input.status) ? "spinner" : input.status === "complete" ? "check" : "info"} size={13} className={inputPending(input.status) ? "animate-spin" : undefined} />
    <span className="cc-input-status">{inputStatusLabel[input.status]}</span>
    <span className="cc-input-preview" title={input.detail || input.text}>{input.detail || input.text || "图片补充"}</span>
    {input.text && <button type="button" onClick={() => onRecover(input.text!)} title="仅恢复文字，不会重新发送；图片请重新添加">恢复文字</button>}
  </div>;
  return <div className="cc-input-receipts" aria-label="插话回执">
    <div role="status" aria-live="polite">{row(latest)}</div>
    {(items.length > 1 || inputPending(latest.status)) && <details>
      <summary>{pending ? `${pending} 条补充等待处理` : `${items.length} 条插话记录`}<span>工具完成后读取补充 · 回执不代表操作已成功</span></summary>
      <div className="cc-input-history">{items.map(row)}</div>
    </details>}
  </div>;
}
